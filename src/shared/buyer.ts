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

export interface Buyer {
  /** fetch() wrapped to transparently pay 402s, subject to the per-payment cap. */
  pay: typeof fetch;
  /** Decode the settlement receipt from a response, or undefined if the payment was cancelled. */
  readReceipt: (res: Response) => SettleResponse | undefined;
  /** This buyer's wallet address (for logging / margin display). */
  address: `0x${string}`;
}

export function makeBuyer(privateKey: `0x${string}`, capAtomic: bigint): Buyer {
  const signer = privateKeyToAccount(privateKey);

  // SelectPaymentRequirements: (x402Version, accepts[]) => chosen requirement.
  const selector = (_v: number, accepts: PaymentRequirements[]): PaymentRequirements => {
    const affordable = accepts.filter((r) => BigInt(r.amount) <= capAtomic);
    if (affordable.length === 0) {
      throw new Error(
        `all ${accepts.length} payment option(s) exceed the per-payment cap of ${capAtomic} atomic`,
      );
    }
    return affordable.reduce((a, b) => (BigInt(a.amount) <= BigInt(b.amount) ? a : b)); // cheapest
  };

  const client = new x402Client(selector);
  registerExactEvmScheme(client, { signer });

  const pay = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  const readReceipt = (res: Response): SettleResponse | undefined => {
    try {
      return httpClient.getPaymentSettleResponse((n: string) => res.headers.get(n));
    } catch {
      return undefined; // no X-PAYMENT-RESPONSE header => payment was cancelled, not settled
    }
  };

  return { pay, readReceipt, address: signer.address };
}
