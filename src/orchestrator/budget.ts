/**
 * BudgetGuard — the per-goal spend cap, and itself a limitation demo (plan §7/§11 row 3).
 *
 * x402 authorizes ONE transfer for ONE resource. Even v2's `upto` scheme only bounds a SINGLE hop
 * ("pay at most $X to THIS seller"). There is no protocol notion of "spend at most $X across this
 * whole goal/chain." So the goal cap lives in OUR code — and the orchestrator can only `record()`
 * the hop IT pays (orchestrator->search). Once it has paid search it has no visibility into, or
 * veto over, search->fetch->verify. The TRUE chain total is reconstructed by the Ledger from
 * /ingest events; the gap between "what I could enforce" and "what actually settled" is the point.
 */
export class BudgetGuard {
  spent = 0;
  constructor(public readonly capUsd: number) {}

  /** Record a hop the orchestrator directly paid. Throws if its OWN spend breaches the cap. */
  record(amountUsd: number): void {
    this.spent = +(this.spent + amountUsd).toFixed(6);
    if (this.spent > this.capUsd) {
      throw new Error(`BUDGET EXCEEDED: $${this.spent.toFixed(4)} > $${this.capUsd}`);
    }
  }
}
