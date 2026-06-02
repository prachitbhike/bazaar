/**
 * reportEvent() — every agent POSTs its events to the orchestrator's /ingest (plan §0.2).
 *
 * Why not an in-process EventEmitter: each agent is its own Node process, so an in-process bus
 * would only ever reach that process. The orchestrator owns the single WebSocket fan-out, so all
 * events funnel through its /ingest.
 *
 * Why await: the call chain is strictly nested (orchestrator -> search -> fetch -> verify), so we
 * await the POST before the agent responds. That guarantees every downstream hop_settled/stranded
 * event is in the orchestrator's ledger by the time control unwinds back up and the budget check
 * runs (§7). It's a localhost POST — negligible cost. Delivery is best-effort: a missing/late
 * dashboard must never break the payment chain.
 */
import type { CascadeEvent } from "./types";

const INGEST_URL = process.env.ORCH_INGEST_URL ?? "http://localhost:4000/ingest";

export async function reportEvent(evt: CascadeEvent): Promise<void> {
  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...evt, ts: evt.ts ?? Date.now() }),
    });
  } catch (err) {
    console.warn(
      `[report] could not POST ${evt.type} (goal ${evt.goalId}) to ${INGEST_URL}:`,
      (err as Error)?.message ?? err,
    );
  }
}
