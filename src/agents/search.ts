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
import { makeBuyer } from "../shared/buyer";
import { priceFor, priceForUsd, bumpLoad } from "../shared/pricing";
import { reportEvent } from "../shared/report";
import { hopDepthGuard, goalIdOf, nextHopHeaders } from "../shared/hops";

const PAY_TO = process.env.SEARCH_PAY_TO as `0x${string}`;
const NETWORK = process.env.NETWORK as `${string}:${string}`;
const FETCH_URL = "http://localhost:4002/fetch";
if (!PAY_TO || !process.env.SEARCH_PRIVATE_KEY) throw new Error("SEARCH_PAY_TO and SEARCH_PRIVATE_KEY are required");

const { pay, readReceipt } = makeBuyer(process.env.SEARCH_PRIVATE_KEY as `0x${string}`, 50_000n);

const app = express();

app.post("/surge", (_req, res) => {
  bumpLoad("search", 5);
  res.json({ ok: true, price: priceFor("search") });
});

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
  try {
    await reportEvent({ type: "work_done", agent: "search", goalId, detail: "found candidate sources" });
    await reportEvent({ type: "hop_start", from: "search", to: "fetch", goalId });

    const r = await pay(FETCH_URL, { method: "GET", headers: nextHopHeaders(req, goalId) });
    if (!r.ok) throw new Error(`fetch returned ${r.status}`);

    const page = (await r.json()) as { _priceUsd?: number };
    const receipt = readReceipt(r);
    const paidUsd = page._priceUsd ?? 0;
    await reportEvent({
      type: "hop_settled",
      from: "search",
      to: "fetch",
      goalId,
      amountUsd: paidUsd,
      tx: receipt?.transaction,
      latencyMs: Date.now() - t0,
    });

    res.json({ answer: "…synthesized from fetched + verified sources…", source: page, _priceUsd: priceForUsd("search") });
    bumpLoad("search");
  } catch (err: any) {
    await reportEvent({ type: "hop_failed", from: "search", to: "fetch", goalId, reason: String(err?.message ?? err) });
    res.status(502).json({ error: "downstream fetch failed" }); // cancels orchestrator->search
  }
});

app.listen(4001, () => {
  console.log(`search (seller+buyer) on :4001  payTo=${PAY_TO}  -> ${FETCH_URL}`);
});
