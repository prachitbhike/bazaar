/**
 * orchestrator — top buyer + event hub + dashboard host (plan §7). Port 4000.
 *
 * Owns the SINGLE event funnel: every event — its own AND the agents' (via /ingest) — flows through
 * emit(), which appends to the log, applies it to the Ledger, and fans it out over WebSocket. That's
 * the fix for two plan bugs: (1) four processes can't share an in-process bus (§0.2), and (2)
 * broadcasting without ledger.apply() would drop hop 1 from the totals (§7).
 */
import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { makeBuyer } from "../shared/buyer";
import { Ledger } from "./ledger";
import { BudgetGuard } from "./budget";
import { GOAL_ID_HEADER, HOP_DEPTH_HEADER } from "../shared/hops";
import type { CascadeEvent } from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_URL = "http://localhost:4001/search";

const app = express();
app.use(express.json());
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const ledger = new Ledger();
const eventLog: CascadeEvent[] = []; // append-only history (per-process, in-memory)

// SINGLE funnel for EVERY event — orchestrator's own AND the agents'.
function emit(evt: CascadeEvent): void {
  const stamped = { ...evt, ts: evt.ts ?? Date.now() } as CascadeEvent;
  eventLog.push(stamped);
  ledger.apply(stamped);
  const msg = JSON.stringify(stamped);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

// Replay the log to every new/refreshed dashboard (a raw WS broadcast is ephemeral, §9).
wss.on("connection", (ws) => {
  for (const evt of eventLog) ws.send(JSON.stringify(evt));
});

// Explicit pull alternative to the WS replay.
app.get("/state", (req, res) => {
  const goalId = req.query.goalId as string | undefined;
  res.json(goalId ? eventLog.filter((e) => e.goalId === goalId) : eventLog);
});

// Event hub: every agent POSTs its events here (§0.2); they flow through the same emit().
app.post("/ingest", (req, res) => {
  emit(req.body as CascadeEvent);
  res.sendStatus(204);
});

const { pay, readReceipt } = makeBuyer(process.env.ORCH_PRIVATE_KEY as `0x${string}`, 50_000n);
const budgets = new Map<string, BudgetGuard>(); // keyed by goalId, NOT a singleton (§12)

app.use(express.static(path.join(__dirname, "..", "dashboard")));

app.post("/goal", async (req, res) => {
  const goalId = randomUUID().slice(0, 8);
  // Cap is set BELOW the base chain total ($0.02 + $0.01 + $0.005 = $0.035) so the overage shows
  // WITHOUT surging (§7/§11 row 3). Surge to make it more dramatic.
  const budget = new BudgetGuard(0.03);
  budgets.set(goalId, budget);

  const t0 = Date.now();
  emit({ type: "goal_start", goalId, goal: req.body?.goal ?? "demo goal", capUsd: budget.capUsd });
  emit({ type: "hop_start", from: "orchestrator", to: "search", goalId });

  try {
    const r = await pay(SEARCH_URL, {
      method: "GET",
      headers: { [GOAL_ID_HEADER]: goalId, [HOP_DEPTH_HEADER]: "1" },
    });
    if (!r.ok) throw new Error(`search returned ${r.status}`);

    const data = (await r.json()) as { _priceUsd?: number };
    const receipt = readReceipt(r);
    const paid = data._priceUsd ?? 0;
    budget.record(paid); // enforces HOP 1 ONLY — see budget.ts; can't veto lower hops
    emit({
      type: "hop_settled",
      from: "orchestrator",
      to: "search",
      goalId,
      amountUsd: paid,
      tx: receipt?.transaction,
      latencyMs: Date.now() - t0,
    });

    // Breach is detectable only AFTER the fact, from the reconstructed chain total (observability,
    // not enforcement). Agents await their /ingest POSTs so the ledger is complete here (§7).
    const chainTotal = ledger.total(goalId);
    if (chainTotal > budget.capUsd) {
      emit({
        type: "budget_exceeded",
        goalId,
        capUsd: budget.capUsd,
        chainTotalUsd: chainTotal,
        enforcedUsd: budget.spent,
        detail: "goal cap blown by lower hops the orchestrator could not veto",
      });
    }

    emit({ type: "goal_done", goalId, result: data, spent: chainTotal });
    res.json({ ok: true, goalId, data, spent: chainTotal, strandedUsd: ledger.strandedTotal(goalId) });
  } catch (err: any) {
    emit({ type: "goal_failed", goalId, reason: String(err?.message ?? err), spent: ledger.total(goalId) });
    res.status(502).json({
      ok: false,
      goalId,
      error: String(err?.message ?? err),
      spent: ledger.total(goalId),
      strandedUsd: ledger.strandedTotal(goalId),
    });
  }
});

httpServer.listen(4000, () => {
  console.log(`orchestrator + dashboard on http://localhost:4000  (buyer ${ "" + (process.env.ORCH_PRIVATE_KEY ? "loaded" : "MISSING") })`);
});
