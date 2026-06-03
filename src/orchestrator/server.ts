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
import { makeBuyer, readBody, readSettlement, composeSettlement } from "../shared/buyer";
import { Ledger } from "./ledger";
import { BudgetGuard } from "./budget";
import { runInHopContext } from "../shared/hops";
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
  for (const c of wss.clients) {
    if (c.readyState !== WebSocket.OPEN) continue;
    // A dead/half-closed socket (e.g. browser tab closed mid-broadcast) must not crash the funnel.
    try {
      c.send(msg);
    } catch (err) {
      console.error("[ws] broadcast send failed:", err);
    }
  }
}

// A socket 'error' (e.g. ECONNRESET when a tab closes mid-replay) is rethrown as an unhandled
// exception by `ws` if unhandled — and this process is the SINGLE event hub for every goal. Swallow
// it at the server level too so a listener failure can't kill the orchestrator.
wss.on("error", (err) => console.error("[ws] server error:", err));

// Replay the log to every new/refreshed dashboard (a raw WS broadcast is ephemeral, §9).
wss.on("connection", (ws) => {
  ws.on("error", (err) => console.error("[ws] connection error:", err));
  for (const evt of eventLog) {
    try {
      ws.send(JSON.stringify(evt));
    } catch (err) {
      console.error("[ws] replay send failed:", err);
      break; // socket is gone — stop replaying to it
    }
  }
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

// Validate the key BEFORE makeBuyer — otherwise a missing/placeholder "0x" makes viem's
// privateKeyToAccount throw a cryptic error at module load, before listen(). Match the agents' style.
const ORCH_PRIVATE_KEY = process.env.ORCH_PRIVATE_KEY;
if (!ORCH_PRIVATE_KEY || ORCH_PRIVATE_KEY === "0x") throw new Error("ORCH_PRIVATE_KEY is required");

const { pay, readReceipt, settledAmountUsd } = makeBuyer(ORCH_PRIVATE_KEY as `0x${string}`, 50_000n);

app.use(express.static(path.join(__dirname, "..", "dashboard")));

app.post("/goal", async (req, res) => {
  const goalId = randomUUID().slice(0, 8);
  // Cap is set BELOW the base chain total ($0.02 + $0.01 + $0.005 = $0.035) so the overage shows
  // WITHOUT surging (§7/§11 row 3). Surge to make it more dramatic.
  const budget = new BudgetGuard(0.03);

  emit({ type: "goal_start", goalId, goal: req.body?.goal ?? "demo goal", capUsd: budget.capUsd });
  emit({ type: "hop_start", from: "orchestrator", to: "search", goalId });

  // Authoritative, in-band totals — propagated up the synchronous call chain from each seller's
  // _settlement summary, NOT reconstructed from /ingest events. A dropped/failed event can therefore
  // no longer make the budget check a false negative (#2/#4). The Ledger still ingests events for the
  // live dashboard + per-agent margins (via emit() -> ledger.apply), but no longer backs these numbers.
  let chainTotalUsd = 0;
  let strandedUsd = 0;
  let resultData: unknown = null;

  try {
    await runInHopContext({ goalId, depth: 0 }, async () => {
      const hopStart = Date.now();
      const r = await pay(SEARCH_URL, { method: "GET" }); // goalId + X-Hop-Depth:1 auto-stamped by the buyer (#6)
      const hopMs = Date.now() - hopStart;

      const body = await readBody(r); // carries search's result AND its in-band _settlement summary
      const downstream = readSettlement(body);
      const { _settlement, ...clean } = (body ?? {}) as Record<string, unknown>;
      resultData = clean;

      // Whether or not OUR hop settles, stranded/settled spend BELOW search already moved on-chain;
      // surface it from the in-band summary so even a FAILED goal reports what was lost (#2). Until
      // our hop proves settled, fold it in as cancelled (own contribution 0).
      ({ settledUsd: chainTotalUsd, strandedUsd } = composeSettlement(0, 0, downstream, 0));

      // search returned >=400 => orchestrator->search was CANCELLED (settle-on-2xx, §0.1). Nothing of
      // OURS settled, but the deepest stranded settlement (captured above) still happened.
      if (!r.ok) throw new Error(`search returned ${r.status}`);

      // search returned 2xx => this hop ALREADY settled on-chain. Use the authoritative amount we
      // signed in the 402, never a recomputed echo (#4).
      const paidUsd = settledAmountUsd(r);
      const receipt = readReceipt(r);
      emit({
        type: "hop_settled",
        from: "orchestrator",
        to: "search",
        goalId,
        amountUsd: paidUsd,
        tx: receipt?.transaction,
        latencyMs: Math.max(0, hopMs - downstream.latencyMs), // TRUE per-hop latency: our RT minus search's own (#5)
      });

      // Fold in our settled hop (same operation each agent does) BEFORE record(), so money that moved
      // stays observable even if the hop-1 cap enforcement below throws — the headline's whole job (§7).
      ({ settledUsd: chainTotalUsd, strandedUsd } = composeSettlement(paidUsd, 0, downstream, 0));
      budget.record(paidUsd); // enforces HOP 1 ONLY — see budget.ts; can't veto lower hops
    });

    // Breach is detectable only AFTER the fact, from the reconstructed chain total (observability,
    // not enforcement) — now sourced in-band, independent of /ingest delivery (#2).
    if (chainTotalUsd > budget.capUsd) {
      emit({
        type: "budget_exceeded",
        goalId,
        capUsd: budget.capUsd,
        chainTotalUsd,
        enforcedUsd: budget.spent,
        detail: "goal cap blown by lower hops the orchestrator could not veto",
      });
    }

    emit({ type: "goal_done", goalId, result: resultData, spent: chainTotalUsd });
    res.json({ ok: true, goalId, data: resultData, spent: chainTotalUsd, strandedUsd });
  } catch (err: any) {
    emit({ type: "goal_failed", goalId, reason: String(err?.message ?? err), spent: chainTotalUsd });
    res.status(502).json({ ok: false, goalId, error: String(err?.message ?? err), spent: chainTotalUsd, strandedUsd });
  }
});

httpServer.listen(4000, () => {
  // Key is guaranteed present here — validated above before makeBuyer, so no "MISSING" branch.
  console.log("orchestrator + dashboard on http://localhost:4000  (buyer loaded)");
});
