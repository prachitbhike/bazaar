/**
 * Event + ledger types for the cascade demo.
 *
 * Every event carries a `goalId` (plan §3.1) so the dashboard can correlate one run even when
 * several goals are in flight at once. Events are a discriminated union on `type` — the
 * orchestrator's emit()/ledger switch on it (§7). `ts` is stamped at send time by reportEvent()
 * (agents) or emit() (orchestrator).
 */

export type AgentName = "orchestrator" | "search" | "fetch" | "verify";

interface BaseEvent {
  goalId: string;
  ts?: number; // epoch ms, stamped at send time
}

export type CascadeEvent =
  // ---- goal lifecycle (orchestrator) ----
  | (BaseEvent & { type: "goal_start"; goal: string; capUsd: number })
  | (BaseEvent & { type: "goal_done"; result: unknown; spent: number })
  | (BaseEvent & { type: "goal_failed"; reason: string; spent: number })
  // ---- per-hop payment lifecycle ----
  | (BaseEvent & { type: "hop_start"; from: AgentName; to: AgentName })
  | (BaseEvent & {
      type: "hop_settled";
      from: AgentName;
      to: AgentName;
      amountUsd: number;
      tx?: string; // on-chain settlement tx hash (proof)
      latencyMs?: number;
    })
  | (BaseEvent & { type: "hop_failed"; from: AgentName; to: AgentName; reason: string })
  // ---- per-agent work ----
  | (BaseEvent & { type: "work_done"; agent: AgentName; detail: string })
  | (BaseEvent & { type: "work_failed"; agent: AgentName; detail: string })
  // ---- the headline: USDC that settled on-chain but produced nothing usable (§6/§11) ----
  | (BaseEvent & { type: "stranded"; agent: AgentName; amountUsd: number; tx?: string; reason: string })
  // ---- observability-only breach of the per-goal cap (§7) ----
  | (BaseEvent & {
      type: "budget_exceeded";
      capUsd: number;
      chainTotalUsd: number;
      enforcedUsd: number;
      detail: string;
    });

export type CascadeEventType = CascadeEvent["type"];
