/**
 * search — recursive agent one level up (plan §6). Seller on GET /search AND buyer of fetch. Port 4001.
 *
 * Same seller+buyer pattern as fetch (shared in makeRecursiveAgent), repointed at fetch. search has
 * NO stranded-spend rule of its own: its payment to fetch either settles (fetch returns a usable
 * 200) or is CANCELLED (fetch returns 5xx) — it never settles-then-wastes. The settle-then-waste
 * loss always lands on the DEEPEST successful settlement, which is fetch->verify (§0.1/§6). search
 * just propagates failure up — so it passes no `onResult` hook.
 */
import "dotenv/config";
import { makeRecursiveAgent } from "../shared/recursiveAgent";

const PAY_TO = process.env.SEARCH_PAY_TO as `0x${string}`;
const NETWORK = process.env.NETWORK as `${string}:${string}`;
if (!PAY_TO || !process.env.SEARCH_PRIVATE_KEY) throw new Error("SEARCH_PAY_TO and SEARCH_PRIVATE_KEY are required");

makeRecursiveAgent({
  self: "search",
  downstream: "fetch",
  routeKey: "GET /search",
  port: 4001,
  payTo: PAY_TO,
  privateKey: process.env.SEARCH_PRIVATE_KEY as `0x${string}`,
  network: NETWORK,
  downstreamUrl: "http://localhost:4002/fetch",
  priceKey: "search",
  paywallDescription: "Search for sources, fetched + verified",
  workDetail: "found candidate sources",
  buildResult: (source) => ({ answer: "…synthesized from fetched + verified sources…", source }),
  downstreamFailMsg: "downstream fetch failed",
});
