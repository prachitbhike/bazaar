/**
 * Per-request dynamic pricing (plan §8).
 *
 * Per-process state: each agent runs in its own process, so each owns its own `load` map. The
 * dashboard's "congestion" button therefore POSTs to the SPECIFIC seller's /surge (e.g. :4003),
 * never the orchestrator (§0.2). Because the seller's paywall reads priceFor() per request (native
 * DynamicPrice callback — see shared/paywall.ts), the very next 402 reflects the bump.
 *
 * Base chain total at zero load: search $0.02 + fetch $0.01 + verify $0.005 = $0.035, which is
 * deliberately above the orchestrator's $0.03 goal cap so the composition gap shows without surging
 * (§7/§11 row 3).
 */
import type { AgentName } from "./types";

type Seller = Exclude<AgentName, "orchestrator">;

const load: Record<Seller, number> = { search: 0, fetch: 0, verify: 0 };
const BASE: Record<Seller, number> = { search: 0.02, fetch: 0.01, verify: 0.005 };

/** Bump a seller's load. Call AFTER responding so it affects the NEXT goal, not the in-flight quote (§0.3). */
export function bumpLoad(agent: Seller, by = 1): void {
  load[agent] = (load[agent] ?? 0) + by;
}

/** Current price in USD (number) — used for ledgering the exact charge echoed in-band (§5). */
export function priceForUsd(agent: Seller): number {
  const surge = 1 + Math.min(load[agent] ?? 0, 10) * 0.05; // up to +50%
  return +(BASE[agent] * surge).toFixed(4);
}

/** Current price as the `$x.xxxx` string the x402 PaymentOption expects. */
export function priceFor(agent: Seller): `$${string}` {
  return `$${priceForUsd(agent)}` as `$${string}`;
}
