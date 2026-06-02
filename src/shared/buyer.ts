/**
 * makeBuyer() — an x402Client whose SELECTOR enforces a per-payment spend cap (plan §6, §12).
 *
 * v2 has no `maxValue` arg on wrapFetchWithPayment; the per-payment ceiling lives in the selector
 * that chooses among the 402's `accepts[]` options (each carries `.amount` in atomic units). If
 * every option exceeds the cap the selector throws — a clean on-screen demo of the per-payment
 * ceiling (§8). Otherwise it picks the cheapest affordable option.
 *
 * Scheme registration uses Form B (registerExactEvmScheme), confirmed exported + working in the
 * step-0 spike. The exact scheme is gasless for the payer (facilitator sponsors gas), so no rpcUrl
 * is needed here.
 *
 * readReceipt wraps getPaymentSettleResponse in try/catch: SPIKE FINDING (b) — it THROWS
 * "Payment response header not found" on the cancel path (>=400 handler), it does NOT return
 * undefined. The thrown case means "no settlement happened", which we represent as undefined.
 */
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { GOAL_ID_HEADER, HOP_DEPTH_HEADER, currentHop } from "./hops";
import type { SettlementSummary } from "./types";

/** This demo settles exclusively in Base Sepolia USDC, which has 6 decimals; amounts cross the wire
 * (the 402 `amount`, the per-payment cap) in atomic units. */
export const USDC_DECIMALS = 6;

/** Convert an atomic USDC amount to a USD number, at the Ledger's 6-decimal precision. */
export function atomicToUsd(atomic: bigint): number {
  return +(Number(atomic) / 10 ** USDC_DECIMALS).toFixed(6);
}

export interface Buyer {
  /**
   * fetch() wrapped to transparently pay 402s, subject to the per-payment cap. It also auto-stamps
   * X-Goal-Id / X-Hop-Depth from the ambient hop context (shared/hops.ts) so every downstream call —
   * including the wrapper's automatic 402->paid retry — carries them, and no caller can forget (#6).
   */
  pay: typeof fetch;
  /** Decode the settlement receipt from a response, or undefined if the payment was cancelled. */
  readReceipt: (res: Response) => SettleResponse | undefined;
  /**
   * The AUTHORITATIVE USD that settled for the hop that produced `res` — the amount the buyer signed
   * in the 402 (or SettleResponse.amount for schemes like `upto` where settlement may differ). Never
   * a recomputed price echo, so a concurrent /surge can't make it diverge from what moved on-chain
   * (#4). Throws on a settled response with no resolvable amount — a settlement is never recorded as
   * $0 (#4b). Call only after a 2xx (settle-on-2xx); on the cancel path nothing settled.
   */
  settledAmountUsd: (res: Response) => number;
  /** This buyer's wallet address (for logging / margin display). */
  address: `0x${string}`;
}

export function makeBuyer(privateKey: `0x${string}`, capAtomic: bigint): Buyer {
  const signer = privateKeyToAccount(privateKey);

  // SelectPaymentRequirements: (x402Version, accepts[]) => chosen requirement. As a side effect it
  // records the chosen atomic amount in the ambient hop context, so the caller can later read the
  // EXACT amount it signed (the authoritative settled amount for the exact scheme) — see #4.
  const selector = (_v: number, accepts: PaymentRequirements[]): PaymentRequirements => {
    const affordable = accepts.filter((r) => BigInt(r.amount) <= capAtomic);
    if (affordable.length === 0) {
      throw new Error(
        `all ${accepts.length} payment option(s) exceed the per-payment cap of ${capAtomic} atomic`,
      );
    }
    const chosen = affordable.reduce((a, b) => (BigInt(a.amount) <= BigInt(b.amount) ? a : b)); // cheapest
    const ctx = currentHop();
    if (ctx) ctx.signedAtomic = BigInt(chosen.amount);
    return chosen;
  };

  const client = new x402Client(selector);
  registerExactEvmScheme(client, { signer });

  const wrapped = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  // Stamp the hop headers from the ambient context on every outbound call. The x402 wrapper re-derives
  // its retry request from this same `init`, so the headers survive the 402->paid retry (verified
  // against @x402/fetch internals); stamping here also means no agent has to remember them (#6).
  const pay: typeof fetch = (input, init) => {
    const ctx = currentHop();
    if (!ctx) return wrapped(input, init); // no hop context (non-agent caller): pass through unchanged
    ctx.signedAtomic = undefined; // reset; the selector sets it iff this call actually signs a 402
    const headers = new Headers(init?.headers);
    headers.set(GOAL_ID_HEADER, ctx.goalId);
    headers.set(HOP_DEPTH_HEADER, String(ctx.depth + 1)); // outbound depth = inbound + 1 (root orch: 0 -> 1)
    return wrapped(input, { ...init, headers });
  };

  const readReceipt = (res: Response): SettleResponse | undefined => {
    try {
      return httpClient.getPaymentSettleResponse((n: string) => res.headers.get(n));
    } catch (err: any) {
      // ONLY the documented cancel path returns undefined: the SDK throws this exact message when
      // there is no PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header (spike finding (b)). Any OTHER
      // error here means the header WAS present but failed to decode — a real settled receipt we
      // must not silently drop (it would ledger as tx: undefined, indistinguishable from a cancel).
      if (err instanceof Error && err.message === "Payment response header not found") {
        return undefined; // no settlement header => payment was cancelled, not settled
      }
      throw err; // settled-but-undecodable receipt: surface it, don't lose the on-chain proof
    }
  };

  const settledAmountUsd = (res: Response): number => {
    const receipt = readReceipt(res);
    if (!receipt) {
      throw new Error("settledAmountUsd: no settlement receipt on a response presumed settled (2xx)");
    }
    // SettleResponse.amount is present only for schemes like `upto`; for the exact scheme it's absent,
    // so we fall back to the atomic amount the selector signed for THIS request (captured in the hop ctx).
    const atomic = receipt.amount != null ? BigInt(receipt.amount) : currentHop()?.signedAtomic;
    if (atomic == null) {
      throw new Error("settledAmountUsd: settled hop has no resolvable amount (signer/selector did not run?)");
    }
    return atomicToUsd(atomic);
  };

  return { pay, readReceipt, settledAmountUsd, address: signer.address };
}

/** Read a downstream seller's response body once, tolerating a non-JSON / empty body (returns undefined). */
export async function readBody(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Extract the in-band settlement summary a downstream seller returned (`_settlement`), defaulting any
 * missing field to 0. Read on BOTH the 2xx and the >=400 paths so stranded spend below a cancelled
 * hop still propagates up the chain (#2). A missing summary => zeros (nothing observed below us).
 */
export function readSettlement(body: any): SettlementSummary {
  const s = body?._settlement;
  return {
    settledUsd: typeof s?.settledUsd === "number" ? s.settledUsd : 0,
    strandedUsd: typeof s?.strandedUsd === "number" ? s.strandedUsd : 0,
    latencyMs: typeof s?.latencyMs === "number" ? s.latencyMs : 0,
  };
}

/**
 * Fold a responder's OWN hop into its downstream summary to produce the summary it reports upward
 * (or, for the root orchestrator, its headline totals). `ownSettledUsd` is what the responder's own
 * outbound hop settled (0 if it was cancelled); `ownStrandedUsd` is how much of that the responder
 * itself stranded (settled with its seller, then couldn't resell — the fetch→verify "degraded" case,
 * §11). Totals are summed at the Ledger's 6-decimal precision.
 */
export function composeSettlement(
  ownSettledUsd: number,
  ownStrandedUsd: number,
  downstream: SettlementSummary,
  latencyMs: number,
): SettlementSummary {
  return {
    settledUsd: +(ownSettledUsd + downstream.settledUsd).toFixed(6),
    strandedUsd: +(ownStrandedUsd + downstream.strandedUsd).toFixed(6),
    latencyMs,
  };
}
