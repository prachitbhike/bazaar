/**
 * fetch — the recursive MIDDLE agent (plan §6). Seller on GET /fetch AND buyer of verify. Port 4002.
 *
 * This is the heart of the demo and where GENUINE stranded spend is produced. Read §0.1: settlement
 * is gated on the handler's status code. So when verify comes back DEGRADED (a 200 that SETTLES, but
 * confidence too low to resell), fetch has already paid verify on-chain (real tx) yet must return a
 * 5xx upstream — which CANCELS search->fetch. fetch is out of pocket with no revenue and no rollback:
 * the deepest successful settlement that became worthless. That is the headline (§11).
 */
import "dotenv/config";
import express from "express";
import { makePaywall } from "../shared/paywall";
import { makeBuyer, readBody, readSettlement, composeSettlement } from "../shared/buyer";
import { priceFor, bumpLoad } from "../shared/pricing";
import { reportEvent } from "../shared/report";
import { hopDepthGuard, hopContextMiddleware, goalIdOf } from "../shared/hops";
import type { SettlementSummary } from "../shared/types";

const PAY_TO = process.env.FETCH_PAY_TO as `0x${string}`;
const NETWORK = process.env.NETWORK as `${string}:${string}`;
const VERIFY_URL = "http://localhost:4003/verify";
if (!PAY_TO || !process.env.FETCH_PRIVATE_KEY) throw new Error("FETCH_PAY_TO and FETCH_PRIVATE_KEY are required");

// per-payment cap: 50000 atomic = $0.05 (USDC has 6 decimals). The cap lives in the selector (§6/§12).
const { pay, readReceipt, settledAmountUsd } = makeBuyer(process.env.FETCH_PRIVATE_KEY as `0x${string}`, 50_000n);

const app = express();

app.post("/surge", (_req, res) => {
  bumpLoad("fetch", 5);
  res.json({ ok: true, price: priceFor("fetch") });
});

app.use(hopContextMiddleware); // seed goalId/depth so the buyer auto-stamps the next hop's headers (#6)
app.use(hopDepthGuard);
app.use(
  makePaywall({
    routeKey: "GET /fetch",
    payTo: PAY_TO,
    network: NETWORK,
    priceNow: () => priceFor("fetch"),
    description: "Fetch + clean a page, with verification",
  }),
);

app.get("/fetch", async (req, res) => {
  const goalId = goalIdOf(req);
  const t0 = Date.now();
  // verify's in-band summary; read below regardless of status so stranded spend BELOW us still
  // propagates up even when our own sale cancels (#2). Stays zero if pay() throws before responding.
  let downstream: SettlementSummary = { settledUsd: 0, strandedUsd: 0, latencyMs: 0 };
  try {
    await reportEvent({ type: "work_done", agent: "fetch", goalId, detail: "fetched + cleaned page" });
    await reportEvent({ type: "hop_start", from: "fetch", to: "verify", goalId });

    const hopStart = Date.now();
    const r = await pay(VERIFY_URL, { method: "GET" }); // goalId + hop depth auto-stamped by the buyer (#6)
    const hopMs = Date.now() - hopStart;

    const body = await readBody(r); // read once: carries both the business fields AND verify's _settlement
    downstream = readSettlement(body);

    // verify returned >=400 => the middleware CANCELLED our payment (we paid nothing) but we have
    // nothing to sell. Propagate as our own failure (which cancels OUR upstream payment too).
    if (!r.ok) throw new Error(`verify returned ${r.status}`);

    const paidUsd = settledAmountUsd(r); // authoritative: the amount we signed on-chain, never a $0 echo (#4)
    const receipt = readReceipt(r); // tx hash = on-chain proof of settlement
    const verification = body as { confidence: number };
    await reportEvent({
      type: "hop_settled",
      from: "fetch",
      to: "verify",
      goalId,
      amountUsd: paidUsd,
      tx: receipt?.transaction,
      latencyMs: Math.max(0, hopMs - downstream.latencyMs), // TRUE per-hop latency: our RT minus verify's own (#5)
    });

    // BUSINESS RULE that creates GENUINE stranded spend (§11, verify mode "degraded"): we already
    // SETTLED with verify (real USDC, tx exists), but the result is unusable, so we can't sell it
    // upstream -> we return 5xx -> search's payment to us is CANCELLED. Out of pocket, no recourse.
    if (verification.confidence < 0.5) {
      await reportEvent({
        type: "stranded",
        agent: "fetch",
        goalId,
        amountUsd: paidUsd,
        tx: receipt?.transaction,
        reason: "paid verify (settled), result unusable, cannot resell",
      });
      res.status(502).json({
        error: "verification unusable",
        stranded: true,
        // our payment to verify SETTLED then stranded; carry it (plus anything below) up in-band (#2).
        _settlement: composeSettlement(paidUsd, paidUsd, downstream, Date.now() - t0),
      });
      return;
    }

    res.json({
      page: "…cleaned content…",
      verification,
      _settlement: composeSettlement(paidUsd, 0, downstream, Date.now() - t0),
    });
    bumpLoad("fetch");
  } catch (err: any) {
    await reportEvent({ type: "hop_failed", from: "fetch", to: "verify", goalId, reason: String(err?.message ?? err) });
    res.status(502).json({
      error: "downstream verification failed", // cancels search->fetch
      // our payment to verify was cancelled (or never signed); only spend BELOW verify (if any)
      // settled — propagate it so the orchestrator's headline stays truthful (#2).
      _settlement: composeSettlement(0, 0, downstream, Date.now() - t0),
    });
  }
});

app.listen(4002, () => {
  console.log(`fetch (seller+buyer) on :4002  payTo=${PAY_TO}  -> ${VERIFY_URL}`);
});
