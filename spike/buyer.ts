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
 * (b) settle-vs-cancel via the balance delta. Items (c)/(d) come from introspect.ts / src/shared/facilitator.ts.
 */
import "dotenv/config";
import { makeBuyer } from "../src/shared/buyer";
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

// makeBuyer (src/shared/buyer.ts) supplies the wrapped fetch + the capped cheapest-affordable
// selector (v2 has no maxValue arg, so the per-payment cap lives in the selector) + readReceipt,
// which wraps getPaymentSettleResponse in a try/catch — SPIKE FINDING (b): it THROWS "Payment
// response header not found" on the cancel path (>=400 handler), so a missing settle header is
// surfaced as undefined. This spike keeps only its own on-chain USDC balance-delta check below.
const { pay, readReceipt, address } = makeBuyer(KEY, CAP);

const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.EVM_RPC_URL) });
const usdcBalance = () =>
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });

console.log(`buyer=${address}  network=${NETWORK}  cap=${CAP} atomic`);

const before = await usdcBalance();
const res = await pay(SELLER, { method: "GET" });

console.log(`\nHTTP ${res.status}`);
console.log("body:", await res.text());

// SPIKE FINDING (b), now encapsulated in shared/buyer's readReceipt: getPaymentSettleResponse
// THROWS "Payment response header not found" on the cancel path (>=400 handler) — it does NOT
// return undefined. readReceipt's try/catch surfaces that missing-header case as undefined.
const settle = readReceipt(res);
console.log("\nSettleResponse:", JSON.stringify(settle ?? null, null, 2));

// SPIKE FINDING (a): the facilitator returns the receipt OPTIMISTICALLY, before the tx is mined,
// so an immediate balance read lags and shows delta=0 even on a real settlement. Wait for the
// settlement tx to mine before reading the after-balance. (The receipt/tx hash is the source of
// truth for the demo's ledger; balance reads are just the spike's independent on-chain check.)
if (settle?.transaction) {
  await pub.waitForTransactionReceipt({ hash: settle.transaction as `0x${string}` });
}
const after = await usdcBalance();

const delta = after - before;
console.log(`\nUSDC balance  before=${before}  after=${after}  delta=${delta}`);
if (settle?.transaction && delta < 0n) {
  console.log(`✅ SETTLED on-chain — tx=${settle.transaction}, buyer charged ${-delta} atomic`);
} else if (!settle?.transaction && delta === 0n) {
  console.log("✅ CANCELLED — no settle header, no on-chain movement (expected on >=400 handler)");
} else {
  console.log("⚠️  unexpected: inspect SettleResponse + delta above");
}
