# Step-0 spike (plan §0 / §13 step 0)

Verify the four load-bearing facts against the *installed* `@x402/*` build **before** writing the
recursive demo. Everything in the plan's §5–§7 is "shape-only" until this passes.

## Files
- `introspect.ts` — prints the real export surface of every `@x402/*` subpath. No keys/network.
- `facilitator.ts` — builds the facilitator client; fails loud if CDP auth isn't wired (finding d).
- `seller.ts` — one `exact` 402 route on `:5001`, with a per-request price callback and a fail-mode toggle.
- `buyer.ts` — pays the seller, prints the decoded `SettleResponse` + on-chain USDC balance delta.

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
- [ ] **(a) End-to-end settlement** works: `buyer` prints a real tx hash and the buyer's USDC balance drops.
- [ ] **(b) Settle-vs-cancel on `>=400`** (plan §0.1): in `error` mode the balance delta is **0** (cancel,
      not settle). This is the fact that *defines* stranded spend — confirm it for your build.
- [ ] **(c) Export surface** (`introspect.ts`): captured in the step-0 report. Key reconciliations vs the plan:
      both `new ExactEvmScheme(...)` and `registerExactEvmScheme(...)` exist; `SettleResponse` is a *type*
      (import from `@x402/core/types`); `getPaymentSettleResponse((n)=>res.headers.get(n))` is the receipt reader.
- [x] **(d) Facilitator auth — RESOLVED.** The CDP facilitator needs `createAuthHeaders`, absent from
      `@x402/*`. Wired via `@coinbase/x402` `createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)`,
      which supplies both the CDP v2 URL and the JWT auth (`spike/facilitator.ts`). Live reachability on
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
