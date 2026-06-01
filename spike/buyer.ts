/**
 * Step-0 spike — BUYER. Pays the seller's GET /ping and prints the decoded SettleResponse,
 * plus the buyer's on-chain USDC balance delta — the rigorous proof of settle-vs-cancel (§0.1).
 *
 * Run (seller must be up on :5001, in a different terminal):
 *   npm run spike:buyer                      # mode=ok  -> expect HTTP 200, a tx hash, balance DROPS
 *   # then: curl -XPOST localhost:5001/_mode/error
 *   npm run spike:buyer                      # mode=error -> expect HTTP 500, NO tx, balance UNCHANGED
 *
 * Confirms §0 items: (a) end-to-end settlement + decoded SettleResponse,
 * (b) settle-vs-cancel via the balance delta. Items (c)/(d) come from introspect.ts / facilitator.ts.
 */
import "dotenv/config";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";

const NETWORK = process.env.NETWORK ?? "eip155:84532";
const KEY = (process.env.BUYER_PRIVATE_KEY ?? process.env.ORCH_PRIVATE_KEY) as `0x${string}`;
const SELLER = "http://localhost:5001/ping";
const CAP = 100_000n; // $0.10 atomic ceiling for the spike (USDC = 6 decimals)

// Base Sepolia USDC — confirm this matches the asset your facilitator settles (spike).
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

if (!KEY || KEY === ("0x" as string)) {
  throw new Error("Set BUYER_PRIVATE_KEY (or ORCH_PRIVATE_KEY) in .env to a FUNDED testnet wallet");
}

const account = privateKeyToAccount(KEY);

// Per-payment cap lives in the selector (v2 has no maxValue arg) — it chooses among accepts[].
const selector = (_v: number, accepts: PaymentRequirements[]): PaymentRequirements => {
  const affordable = accepts.filter((r) => BigInt(r.amount) <= CAP);
  if (affordable.length === 0) {
    throw new Error(`all ${accepts.length} payment options exceed per-payment cap ${CAP}`);
  }
  return affordable.reduce((a, b) => (BigInt(a.amount) <= BigInt(b.amount) ? a : b));
};

const client = new x402Client(selector);
// Form B (helper) — confirmed exported by @x402/evm/exact/client. Confirm `signer` shape at runtime.
registerExactEvmScheme(client, { signer: account });

const pay = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.EVM_RPC_URL) });
const usdcBalance = () =>
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

console.log(`buyer=${account.address}  network=${NETWORK}  cap=${CAP} atomic`);

const before = await usdcBalance();
const res = await pay(SELLER, { method: "GET" });
const after = await usdcBalance();

console.log(`\nHTTP ${res.status}`);
console.log("body:", await res.text());

const settle: SettleResponse | undefined = httpClient.getPaymentSettleResponse((n) => res.headers.get(n));
console.log("\nSettleResponse:", JSON.stringify(settle, null, 2));

const delta = after - before;
console.log(`\nUSDC balance  before=${before}  after=${after}  delta=${delta}`);
if (settle?.transaction && delta < 0n) {
  console.log(`✅ SETTLED on-chain — tx=${settle.transaction}, buyer charged ${-delta} atomic`);
} else if (delta === 0n) {
  console.log("✅ CANCELLED — no on-chain movement (expected in error mode / on >=400 handler)");
} else {
  console.log("⚠️  unexpected: inspect SettleResponse + delta above");
}
