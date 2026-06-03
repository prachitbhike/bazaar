/**
 * fetch — the recursive MIDDLE agent (plan §6). Seller on GET /fetch AND buyer of verify. Port 4002.
 *
 * This is the heart of the demo and where GENUINE stranded spend is produced. Read §0.1: settlement
 * is gated on the handler's status code. So when verify comes back DEGRADED (a 200 that SETTLES, but
 * confidence too low to resell), fetch has already paid verify on-chain (real tx) yet must return a
 * 5xx upstream — which CANCELS search->fetch. fetch is out of pocket with no revenue and no rollback:
 * the deepest successful settlement that became worthless. That is the headline (§11).
 *
 * The shared seller+buyer plumbing lives in makeRecursiveAgent; the "confidence < 0.5 -> strand"
 * rule is fetch's only behavioural difference from search, expressed as the `onResult` hook. The
 * factory folds the stranded amount into the in-band `_settlement` it returns upstream.
 */
import "dotenv/config";
import { makeRecursiveAgent } from "../shared/recursiveAgent";

const PAY_TO = process.env.FETCH_PAY_TO as `0x${string}`;
const NETWORK = process.env.NETWORK as `${string}:${string}`;
if (!PAY_TO || !process.env.FETCH_PRIVATE_KEY) throw new Error("FETCH_PAY_TO and FETCH_PRIVATE_KEY are required");

makeRecursiveAgent({
  self: "fetch",
  downstream: "verify",
  routeKey: "GET /fetch",
  port: 4002,
  payTo: PAY_TO,
  privateKey: process.env.FETCH_PRIVATE_KEY as `0x${string}`,
  network: NETWORK,
  downstreamUrl: "http://localhost:4003/verify",
  priceKey: "fetch",
  paywallDescription: "Fetch + clean a page, with verification",
  workDetail: "fetched + cleaned page",
  buildResult: (verification) => ({ page: "…cleaned content…", verification }),
  downstreamFailMsg: "downstream verification failed",
  // GENUINE stranded spend (§11, verify mode "degraded"): we already SETTLED with verify (real USDC,
  // tx exists), but confidence too low to resell -> 502 -> search's payment to us is CANCELLED.
  onResult: (json) => {
    const { confidence } = json as { confidence: number };
    if (confidence < 0.5) {
      return {
        reason: "paid verify (settled), result unusable, cannot resell",
        errorBody: { error: "verification unusable", stranded: true },
      };
    }
    return null;
  },
});
