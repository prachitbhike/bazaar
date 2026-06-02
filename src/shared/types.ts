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

/**
 * In-band settlement summary every seller returns in its response body (`_settlement`), on BOTH the
 * 2xx and the >=400 paths. It propagates each subtree's TRUE settled total up the synchronous call
 * chain so the orchestrator's headline numbers (chain total, stranded total) are authoritative and
 * do NOT depend on the out-of-band /ingest event POSTs landing (§7). The event stream still feeds
 * the live dashboard; it just no longer carries the load-bearing totals.
 *
 * All amounts are USD, derived from the atomic amount the buyer actually signed in the 402 — never
 * from a recomputed price echo (see shared/buyer.ts `settledAmountUsd`).
 */
export interface SettlementSummary {
  /** Total USDC that settled on-chain in the responder's subtree (its own downstream hop + everything below). */
  settledUsd: number;
  /** Of `settledUsd`, how much settled but produced nothing usable and can't be recovered (the headline, §11). */
  strandedUsd: number;
  /** The responder's own handler wall-clock (request received -> response sent), for true per-hop latency by differencing (§9). */
  latencyMs: number;
}
