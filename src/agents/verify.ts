/**
 * verify — the TERMINAL seller (plan §5). Pure seller, no downstream purchase. Port 4003.
 *
 * Dynamic pricing via the native DynamicPrice callback (shared/paywall.ts). The fail-mode toggle is
 * the heart of the limitation demos (§11):
 *   - "ok"       -> 200, confidence 0.91 -> upstream can resell -> everything settles.
 *   - "degraded" -> 200 (SETTLES), confidence 0.05 -> fetch can't resell -> fetch strands money (§6).
 *   - "error"    -> 500, the middleware CANCELS the incoming payment -> no money moves.
 * "degraded" vs "error" show OPPOSITE protocol behaviors (settle-then-waste vs cancel) — that
 * contrast is the whole point of settle-on-2xx (§0.1).
 */
import "dotenv/config";
import express from "express";
import { makePaywall } from "../shared/paywall";
import { priceFor, bumpLoad } from "../shared/pricing";
import { reportEvent } from "../shared/report";
import { hopDepthGuard, hopContextMiddleware, goalIdOf } from "../shared/hops";

const PAY_TO = process.env.VERIFY_PAY_TO as `0x${string}`;
const NETWORK = process.env.NETWORK as `${string}:${string}`;
if (!PAY_TO) throw new Error("VERIFY_PAY_TO is required");

const app = express();

let mode: "ok" | "degraded" | "error" = "ok";

// Control plane — defined first so the paywall never gates it.
app.post("/mode/:m", (req, res) => {
  const m = req.params.m;
  if (m !== "ok" && m !== "degraded" && m !== "error") {
    res.status(400).json({ error: "mode must be ok|degraded|error" });
    return;
  }
  mode = m;
  res.json({ mode });
});
// per-process surge knob — must live on THIS seller's process, not the orchestrator (§0.2/§8).
app.post("/surge", (_req, res) => {
  bumpLoad("verify", 5);
  res.json({ ok: true, price: priceFor("verify") });
});

app.use(hopContextMiddleware); // seed goalId/depth so the (terminal) hop context is consistent
app.use(hopDepthGuard);
app.use(
  makePaywall({
    routeKey: "GET /verify",
    payTo: PAY_TO,
    network: NETWORK,
    priceNow: () => priceFor("verify"),
    description: "Verify a claim/source",
  }),
);

app.get("/verify", async (req, res) => {
  const goalId = goalIdOf(req);
  const t0 = Date.now();

  // Terminal seller: nothing settles BELOW verify, so its in-band summary is always zeros except for
  // its own handler wall-clock (which lets the buyer compute true per-hop latency by differencing, #5).
  const summary = () => ({ settledUsd: 0, strandedUsd: 0, latencyMs: Date.now() - t0 });

  if (mode === "error") {
    await reportEvent({ type: "work_failed", agent: "verify", goalId, detail: "forced 500" });
    res.status(500).json({ error: "verify failed", _settlement: summary() }); // >=400 -> CANCELS the payment
    return;
  }

  const degraded = mode === "degraded";
  await reportEvent({
    type: "work_done",
    agent: "verify",
    goalId,
    detail: degraded ? "verified (LOW confidence)" : "verified source",
  });

  // 200 -> settles. The buyer ledgers the EXACT charge from the amount it signed in the 402 (see
  // shared/buyer.ts settledAmountUsd), so we no longer echo a recomputed price here (#4).
  res.json({
    verified: !degraded,
    confidence: degraded ? 0.05 : 0.91,
    _settlement: summary(),
  });
  bumpLoad("verify"); // bump AFTER responding -> affects the NEXT goal, not this in-flight quote (§0.3)
});

app.listen(4003, () => {
  console.log(`verify (terminal seller) on :4003  payTo=${PAY_TO}  mode=${mode}  price=${priceFor("verify")}`);
});
