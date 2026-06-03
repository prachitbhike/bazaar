/**
 * GOAL_CAP_USD — the per-goal spend ceiling, and itself a limitation demo (plan §7/§11 row 3).
 *
 * x402 authorizes ONE transfer for ONE resource. Even v2's `upto` scheme only bounds a SINGLE hop
 * ("pay at most $X to THIS seller"). There is no protocol notion of "spend at most $X across this
 * whole goal/chain." So the goal cap lives in OUR code — but it CANNOT be enforced: the orchestrator
 * only pays hop 1 (orchestrator->search) and has no visibility into, or veto over, the lower hops
 * (search->fetch->verify) that hop implicitly triggers. By the time the true chain total is known,
 * every hop has already settled on-chain.
 *
 * So there is deliberately NO guard object that "records" spend and throws on breach — that would
 * imply an enforcement this code structurally cannot do (the orchestrator only ever sees its own
 * hop-1 payment, always well under the cap). The cap is just this number. The TRUE chain total is
 * propagated in-band up the call chain (shared/types.ts SettlementSummary), and server.ts compares
 * it to the cap AFTER the fact: a `chainTotal > cap` breach is OBSERVABILITY, not enforcement. The
 * gap between "what I could enforce" (hop 1) and "what actually settled" (the whole chain) is the point.
 *
 * Set BELOW the base chain total ($0.02 + $0.01 + $0.005 = $0.035) so the overage shows WITHOUT
 * surging. Surge to make it more dramatic.
 */
export const GOAL_CAP_USD = 0.03;
