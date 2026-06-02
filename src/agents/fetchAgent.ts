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
import { makeBuyer } from "../shared/buyer";
import { priceFor, priceForUsd, bumpLoad } from "../shared/pricing";
import { reportEvent } from "../shared/report";
import { hopDepthGuard, goalIdOf, nextHopHeaders } from "../shared/hops";

const PAY_TO = process.env.FETCH_PAY_TO as `0x${string}`;
const NETWORK = process.env.NETWORK as `${string}:${string}`;
const VERIFY_URL = "http://localhost:4003/verify";
if (!PAY_TO || !process.env.FETCH_PRIVATE_KEY) throw new Error("FETCH_PAY_TO and FETCH_PRIVATE_KEY are required");

// per-payment cap: 50000 atomic = $0.05 (USDC has 6 decimals). The cap lives in the selector (§6/§12).
const { pay, readReceipt } = makeBuyer(process.env.FETCH_PRIVATE_KEY as `0x${string}`, 50_000n);

const app = express();

app.post("/surge", (_req, res) => {
  bumpLoad("fetch", 5);
  res.json({ ok: true, price: priceFor("fetch") });
});

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
  try {
    await reportEvent({ type: "work_done", agent: "fetch", goalId, detail: "fetched + cleaned page" });
    await reportEvent({ type: "hop_start", from: "fetch", to: "verify", goalId });

    const r = await pay(VERIFY_URL, { method: "GET", headers: nextHopHeaders(req, goalId) });

    // verify returned >=400 => the middleware CANCELLED our payment (we paid nothing) but we have
    // nothing to sell. Propagate as our own failure (which cancels OUR upstream payment too).
    if (!r.ok) throw new Error(`verify returned ${r.status}`);

    const verification = (await r.json()) as { confidence: number; _priceUsd?: number };
    const receipt = readReceipt(r); // tx hash = on-chain proof of settlement
    const paidUsd = verification._priceUsd ?? 0; // exact charge, echoed in-band (§5)
    await reportEvent({
      type: "hop_settled",
      from: "fetch",
      to: "verify",
      goalId,
      amountUsd: paidUsd,
      tx: receipt?.transaction,
      latencyMs: Date.now() - t0,
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
      res.status(502).json({ error: "verification unusable", stranded: true });
      return;
    }

    res.json({ page: "…cleaned content…", verification, _priceUsd: priceForUsd("fetch") });
    bumpLoad("fetch");
  } catch (err: any) {
    await reportEvent({ type: "hop_failed", from: "fetch", to: "verify", goalId, reason: String(err?.message ?? err) });
    res.status(502).json({ error: "downstream verification failed" }); // cancels search->fetch
  }
});

app.listen(4002, () => {
  console.log(`fetch (seller+buyer) on :4002  payTo=${PAY_TO}  -> ${VERIFY_URL}`);
});
