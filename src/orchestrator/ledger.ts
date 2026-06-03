/**
 * Ledger — per-goalId reconstruction of the payment chain from the event stream (plan §7).
 *
 * The orchestrator only directly pays hop 1; every lower hop reports its settlement via /ingest.
 * The Ledger replays those events to recover the TRUE chain total — which is exactly the
 * observability that exposes the per-goal budget breach the orchestrator can't enforce (§7/§11
 * row 3).
 */
import type { AgentName, CascadeEvent } from "../shared/types";

interface Settlement {
  from: AgentName;
  to: AgentName;
  amountUsd: number;
  tx?: string;
}
interface Stranded {
  agent: AgentName;
  amountUsd: number;
  tx?: string;
  reason: string;
}
interface GoalLedger {
  settlements: Settlement[];
  stranded: Stranded[];
}

export class Ledger {
  private goals = new Map<string, GoalLedger>();

  private get(goalId: string): GoalLedger {
    let g = this.goals.get(goalId);
    if (!g) {
      g = { settlements: [], stranded: [] };
      this.goals.set(goalId, g);
    }
    return g;
  }

  apply(evt: CascadeEvent): void {
    if (evt.type === "hop_settled") {
      this.get(evt.goalId).settlements.push({ from: evt.from, to: evt.to, amountUsd: evt.amountUsd, tx: evt.tx });
    } else if (evt.type === "stranded") {
      this.get(evt.goalId).stranded.push({ agent: evt.agent, amountUsd: evt.amountUsd, tx: evt.tx, reason: evt.reason });
    }
  }

  /** Total USDC that actually SETTLED on-chain across the whole chain for this goal. */
  total(goalId: string): number {
    const g = this.goals.get(goalId);
    if (!g) return 0;
    return +g.settlements.reduce((s, x) => s + x.amountUsd, 0).toFixed(6);
  }

  /** Sum of USDC that settled but produced nothing usable and can't be recovered (the headline). */
  strandedTotal(goalId: string): number {
    const g = this.goals.get(goalId);
    if (!g) return 0;
    return +g.stranded.reduce((s, x) => s + x.amountUsd, 0).toFixed(6);
  }
}
