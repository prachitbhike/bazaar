# Step-0 spike (plan §0 / §13 step 0)

Verify the four load-bearing facts against the *installed* `@x402/*` build **before** writing the
recursive demo. Everything in the plan's §5–§7 is "shape-only" until this passes.

## Files
- `introspect.ts` — prints the real export surface of every `@x402/*` subpath. No keys/network.
- `seller.ts` — one `exact` 402 route on `:5001`, with a per-request price callback and a fail-mode toggle.
  Its paywall is built via the shared `makePaywall` (`src/shared/paywall.ts`), which wires the facilitator
  client (`makeFacilitator`, finding d) — no spike-local copy.
- `buyer.ts` — pays the seller via the shared `makeBuyer` (`src/shared/buyer.ts`: capped selector +
  `readReceipt`), then prints the decoded `SettleResponse` + on-chain USDC balance delta.

## Prereqs (you provide — never hand keys to a tool, plan §3)
In `.env`:
- `ORCH_PRIVATE_KEY` (or `BUYER_PRIVATE_KEY`) — a **funded** Base Sepolia testnet wallet (the buyer).
- `VERIFY_PAY_TO` (or `SELLER_PAY_TO`) — a **different** address that receives payment (the seller).
- `FACILITATOR_URL` + facilitator auth — see finding (d) below.
- `EVM_RPC_URL` — defaults to `https://sepolia.base.org` (used only to read the balance delta).

## Run
```bash
npm run spike:introspect              # (c) export surface — no keys needed

# terminal 1:
npm run spike:seller                  # seller on :5001

# terminal 2:
npm run spike:buyer                   # (a) expect HTTP 200, a tx hash, USDC balance DROPS
curl -XPOST localhost:5001/_mode/error
npm run spike:buyer                   # (b) expect HTTP 500, NO tx, USDC balance UNCHANGED
curl -XPOST localhost:5001/_surge     # bump the live price; re-buy to see the 402 amount move
```

## The four findings to report (plan §0)
- [x] **(a) End-to-end settlement — CONFIRMED** (Base Sepolia, mode=ok). `SettleResponse.success=true`,
      tx `0xdc973e19c2b28a34d1ae49312605e8cf25f698f3f98cee6f08f609a9e96c6a4f` (block 42292275). Buyer
      charged exactly the quoted **1000 atomic = $0.0010**; the payTo address received +1000. **Gotcha:**
      the facilitator returns the receipt *optimistically before the tx mines*, so an immediate balance
      re-read shows delta=0 — trust `SettleResponse` (success + tx hash), or `waitForTransactionReceipt`
      before reading balances. The demo ledger keys off the receipt tx, so this is a non-issue there.
- [x] **(b) Settle-vs-cancel on `>=400` — CONFIRMED** (plan §0.1, mode=error). Handler returned 500 ⇒
      the middleware **cancelled**: NO `X-PAYMENT-RESPONSE` header attached, and on-chain balances were
      **unchanged** (buyer stayed at 19999000). This is the fact that *defines* stranded spend. **Gotcha:**
      `getPaymentSettleResponse(...)` **throws** `"Payment response header not found"` on the cancel path —
      it does NOT return `undefined`. So `shared/buyer.ts`'s `readReceipt` must try/catch — and the spike's
      buyer now calls that shared `readReceipt` directly.
- [x] **(c) Export surface — CONFIRMED** (`npm run spike:introspect`, deps installed, clean `tsc --noEmit`):
      both `ExactEvmScheme` (Form A) and `registerExactEvmScheme` (Form B) are exported from
      `@x402/evm/exact/{client,server}`; `x402Client` / `wrapFetchWithPayment` / `x402HTTPClient` from
      `@x402/fetch`; `paymentMiddleware` + `x402ResourceServer` from `@x402/express`; `HTTPFacilitatorClient`
      from `@x402/core/server`. `SettleResponse`/`PaymentRequirements` are erased *types* (not in runtime keys,
      as expected — `import type` from `@x402/core/types`). All stretch schemes present too: `UptoEvmScheme`,
      `BatchSettlementEvmScheme` (client+server), `AuthCaptureEvmScheme` (client only — server subpath not
      shipped, matches plan §0.4). `setSettlementOverrides` + `SETTLEMENT_OVERRIDES_HEADER` exist for `upto`
      partial settlement.
- [x] **(d) Facilitator auth — RESOLVED.** The CDP facilitator needs `createAuthHeaders`, absent from
      `@x402/*`. Wired via `@coinbase/x402` `createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)`,
      which supplies both the CDP v2 URL and the JWT auth (`src/shared/facilitator.ts`). Live reachability on
      Base Sepolia still confirmed by the (a) settlement run.

## Pre-confirmed by static analysis (no chain needed)
These were already verified against the installed `.d.ts` and a clean `tsc --noEmit`:
- v2 (`@x402/* @ ^2.14`) installs and imports cleanly — **main track, no v1 fallback (Appendix B)**.
- **Native dynamic pricing:** `PaymentOption.price: Price | DynamicPrice` where
  `DynamicPrice = (ctx) => Price`. The 402 amount can be a per-request callback, so the plan's
  §0.3 / §5 per-request middleware-rebuild shim (`dynamicPaywall.ts`) is **unnecessary** for this build.
- `paymentMiddleware(routes, resourceServer)` and `new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme())`
  match the SDK's own example verbatim.

Only items (a), (b), and (d)'s live check require funded keys + a working facilitator.
