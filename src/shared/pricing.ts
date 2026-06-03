/**
 * Per-request dynamic pricing (plan §8).
 *
 * Per-process state: each agent runs in its own process, so each owns its own `load` map. The
 * dashboard's "congestion" button therefore POSTs to the SPECIFIC seller's /surge (e.g. :4003),
 * never the orchestrator (§0.2). Because the seller's paywall reads priceFor() per request (native
 * DynamicPrice callback — see shared/paywall.ts), the very next 402 reflects the bump.
 *
 * Prices are held in ATOMIC USDC units (integers; USDC has 6 decimals) and rendered to the
 * `$x.xxxx` string the x402 PaymentOption expects only at the very edge — so the quote is exact and
 * the old defensive `.toFixed(4)` (which rounded the actually-charged price to 4 dp, e.g. verify
 * under surge $0.00525 -> $0.0053) is gone. The buyer ledgers the authoritative amount it signs from
 * this quote (shared/buyer.ts settledAmountUsd), so an exact quote keeps the charge exact too.
 *
 * Base chain total at zero load: search $0.02 + fetch $0.01 + verify $0.005 = $0.035, which is
 * deliberately above the orchestrator's $0.03 goal cap so the composition gap shows without surging
 * (§7/§11 row 3).
 */
import type { AgentName } from "./types";

type Seller = Exclude<AgentName, "orchestrator">;

const ATOMIC_PER_USDC = 1_000_000; // USDC has 6 decimals

const load: Record<Seller, number> = { search: 0, fetch: 0, verify: 0 };
// Base prices in atomic USDC units: $0.02, $0.01, $0.005.
const BASE_ATOMIC: Record<Seller, number> = { search: 20_000, fetch: 10_000, verify: 5_000 };

/** Bump a seller's load. Call AFTER responding so it affects the NEXT goal, not the in-flight quote (§0.3). */
export function bumpLoad(agent: Seller, by = 1): void {
  load[agent] = (load[agent] ?? 0) + by;
}

/**
 * Current price in ATOMIC USDC units. Exact integer: the bases are multiples of 100 and surge is a
 * whole-percent step, so `* (100 + pct) / 100` never has a remainder — no rounding needed.
 */
function priceAtomic(agent: Seller): number {
  const surgePct = Math.min(load[agent] ?? 0, 10) * 5; // up to +50%
  return Number((BigInt(BASE_ATOMIC[agent]) * BigInt(100 + surgePct)) / 100n);
}

/** Current price as the exact `$x.xxxx` string the x402 PaymentOption expects (the only $-format edge). */
export function priceFor(agent: Seller): `$${string}` {
  const atomic = priceAtomic(agent);
  const whole = Math.trunc(atomic / ATOMIC_PER_USDC);
  const frac = String(atomic % ATOMIC_PER_USDC).padStart(6, "0").replace(/0+$/, "");
  return `$${frac ? `${whole}.${frac}` : whole}` as `$${string}`;
}
