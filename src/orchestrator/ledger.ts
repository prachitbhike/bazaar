/**
 * Ledger — per-goalId reconstruction of the payment chain from the event stream (plan §7).
 *
 * The orchestrator only directly pays hop 1; every lower hop reports its settlement via /ingest.
 * The Ledger replays those events to recover the TRUE chain total and each agent's margin — which
 * is exactly the observability that exposes the per-goal budget breach the orchestrator can't
 * enforce (§7/§11 row 3).
 *
 * Margin convention: in a `hop_settled {from, to, amountUsd}`, `to` earns amountUsd (revenue) and
 * `from` spends it (cost). margin[agent] = revenue[agent] - cost[agent]. The terminal seller
 * (verify) has only revenue; the orchestrator has only cost (pure buyer).
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

  /** Per-agent margin = revenue (paid to it) - cost (it paid downstream). */
  margins(goalId: string): Record<string, number> {
    const g = this.goals.get(goalId);
    const revenue: Record<string, number> = {};
    const cost: Record<string, number> = {};
    for (const s of g?.settlements ?? []) {
      revenue[s.to] = (revenue[s.to] ?? 0) + s.amountUsd;
      cost[s.from] = (cost[s.from] ?? 0) + s.amountUsd;
    }
    const agents = new Set([...Object.keys(revenue), ...Object.keys(cost)]);
    const out: Record<string, number> = {};
    for (const a of agents) out[a] = +((revenue[a] ?? 0) - (cost[a] ?? 0)).toFixed(6);
    return out;
  }
}
