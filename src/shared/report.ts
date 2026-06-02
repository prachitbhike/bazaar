/**
 * reportEvent() — every agent POSTs its events to the orchestrator's /ingest (plan §0.2).
 *
 * Why not an in-process EventEmitter: each agent is its own Node process, so an in-process bus
 * would only ever reach that process. The orchestrator owns the single WebSocket fan-out, so all
 * events funnel through its /ingest.
 *
 * These events drive the LIVE DASHBOARD and the per-agent margin view only. The load-bearing totals
 * (chain total for the budget check, stranded total) are propagated IN-BAND up the synchronous call
 * chain instead (see shared/types.ts `SettlementSummary`), so a dropped/late event can no longer
 * silently undercount what moved on-chain (#2). Delivery is therefore best-effort by design — a
 * missing/late dashboard must never break the payment chain — but it is no longer SILENT: we check
 * res.ok and surface a non-2xx or a transport failure loudly so a broken funnel is visible.
 */
import type { CascadeEvent } from "./types";

const INGEST_URL = process.env.ORCH_INGEST_URL ?? "http://localhost:4000/ingest";

export async function reportEvent(evt: CascadeEvent): Promise<void> {
  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...evt, ts: evt.ts ?? Date.now() }),
    });
    if (!res.ok) {
      console.error(
        `[report] /ingest rejected ${evt.type} (goal ${evt.goalId}) with HTTP ${res.status} — dashboard may be incomplete`,
      );
    }
  } catch (err) {
    console.error(
      `[report] could not POST ${evt.type} (goal ${evt.goalId}) to ${INGEST_URL}:`,
      (err as Error)?.message ?? err,
    );
  }
}
