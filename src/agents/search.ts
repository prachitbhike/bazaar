/**
 * search — recursive agent one level up (plan §6). Seller on GET /search AND buyer of fetch. Port 4001.
 *
 * Same seller+buyer pattern as fetchAgent, repointed at fetch. search has NO stranded-spend rule of
 * its own: its payment to fetch either settles (fetch returns a usable 200) or is CANCELLED (fetch
 * returns 5xx) — it never settles-then-wastes. The settle-then-waste loss always lands on the
 * DEEPEST successful settlement, which is fetch->verify (§0.1/§6). search just propagates failure up.
 */
import "dotenv/config";
import express from "express";
import { makePaywall } from "../shared/paywall";
import { makeBuyer, readBody, readSettlement, composeSettlement } from "../shared/buyer";
import { priceFor, bumpLoad } from "../shared/pricing";
import { reportEvent } from "../shared/report";
import { hopDepthGuard, hopContextMiddleware, goalIdOf } from "../shared/hops";
import type { SettlementSummary } from "../shared/types";

const PAY_TO = process.env.SEARCH_PAY_TO as `0x${string}`;
const NETWORK = process.env.NETWORK as `${string}:${string}`;
const FETCH_URL = "http://localhost:4002/fetch";
if (!PAY_TO || !process.env.SEARCH_PRIVATE_KEY) throw new Error("SEARCH_PAY_TO and SEARCH_PRIVATE_KEY are required");

const { pay, readReceipt, settledAmountUsd } = makeBuyer(process.env.SEARCH_PRIVATE_KEY as `0x${string}`, 50_000n);

const app = express();

app.post("/surge", (_req, res) => {
  bumpLoad("search", 5);
  res.json({ ok: true, price: priceFor("search") });
});

app.use(hopContextMiddleware); // seed goalId/depth so the buyer auto-stamps the next hop's headers (#6)
app.use(hopDepthGuard);
app.use(
  makePaywall({
    routeKey: "GET /search",
    payTo: PAY_TO,
    network: NETWORK,
    priceNow: () => priceFor("search"),
    description: "Search for sources, fetched + verified",
  }),
);

app.get("/search", async (req, res) => {
  const goalId = goalIdOf(req);
  const t0 = Date.now();
  // fetch's in-band summary; read below regardless of status so stranded spend deeper in the chain
  // (fetch->verify) propagates up even when our own sale to the orchestrator cancels (#2).
  let downstream: SettlementSummary = { settledUsd: 0, strandedUsd: 0, latencyMs: 0 };
  try {
    await reportEvent({ type: "work_done", agent: "search", goalId, detail: "found candidate sources" });
    await reportEvent({ type: "hop_start", from: "search", to: "fetch", goalId });

    const hopStart = Date.now();
    const r = await pay(FETCH_URL, { method: "GET" }); // goalId + hop depth auto-stamped by the buyer (#6)
    const hopMs = Date.now() - hopStart;

    const page = await readBody(r); // read once: carries the fetched content AND fetch's _settlement
    downstream = readSettlement(page);

    if (!r.ok) throw new Error(`fetch returned ${r.status}`);

    const paidUsd = settledAmountUsd(r); // authoritative: the amount we signed on-chain, never a $0 echo (#4)
    const receipt = readReceipt(r);
    await reportEvent({
      type: "hop_settled",
      from: "search",
      to: "fetch",
      goalId,
      amountUsd: paidUsd,
      tx: receipt?.transaction,
      latencyMs: Math.max(0, hopMs - downstream.latencyMs), // TRUE per-hop latency: our RT minus fetch's own (#5)
    });

    res.json({
      answer: "…synthesized from fetched + verified sources…",
      source: page,
      // our hop settled; the subtree total is our payment plus everything fetch reported below it.
      // search has no stranded-spend rule of its own (ownStranded=0), so it only forwards fetch's (§6).
      _settlement: composeSettlement(paidUsd, 0, downstream, Date.now() - t0),
    });
    bumpLoad("search");
  } catch (err: any) {
    await reportEvent({ type: "hop_failed", from: "search", to: "fetch", goalId, reason: String(err?.message ?? err) });
    res.status(502).json({
      error: "downstream fetch failed", // cancels orchestrator->search
      // our payment to fetch was cancelled; carry the stranded/settled spend BELOW us up in-band (#2).
      _settlement: composeSettlement(0, 0, downstream, Date.now() - t0),
    });
  }
});

app.listen(4001, () => {
  console.log(`search (seller+buyer) on :4001  payTo=${PAY_TO}  -> ${FETCH_URL}`);
});
