# Cascade

**A recursive payment-chain demo for x402 v2 — a cascade of paywalled AI agents that buy from each other, every hop a real USDC settlement on Base Sepolia.**

Cascade is a tiny ecosystem of paywalled micro-services where an orchestrator completes a user goal by *buying from sellers who buy from each other*. The thesis is **composable, multi-hop payments with per-request dynamic pricing** — payments composing the way HTTP requests compose, which is the actual promise of putting payments in HTTP and something almost no public x402 demo shows. The standard sample is single-agent-pays-single-API; this is the recursive frontier.

It is built on **x402 v2** (the scoped `@x402/*` packages), and that choice sharpens the point. v2 already ships real per-hop solutions — payment channels (`batch-settlement`), cooperative refunds, authorized-max payments (`upto`). Cascade's contribution is demonstrating, with on-chain receipts, that **none of those mechanisms compose across a recursive chain**: a channel is point-to-point, a refund is per-payment, an `upto` cap bounds a single hop. That composition gap is the live frontier — see [the limitations table](#the-composition-gap-the-headline).

> **Testnet only.** Every settlement runs on **Base Sepolia** with testnet USDC. A recursive market with a wiring bug fans out into real settlements fast — never point this at mainnet.

---

## Table of contents

- [The core idea: "stranded spend"](#the-core-idea-stranded-spend)
- [Architecture](#architecture)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Setup](#setup)
- [Running the cascade](#running-the-cascade)
- [Driving the demo](#driving-the-demo)
- [The composition gap (the headline)](#the-composition-gap-the-headline)
- [Safety rails](#safety-rails)
- [Implementation status](#implementation-status)
- [Background](#background)

---

## The core idea: "stranded spend"

The single most important fact about the v2 Express middleware: **settlement is gated on the handler's HTTP status code.**

1. The middleware verifies the incoming payment authorization (facilitator `/verify`).
2. It runs the route handler, buffering the response.
3. It then checks the status:
   - **`>= 400` (or the handler threw)** → the payment is **cancelled**. No `X-PAYMENT-RESPONSE` header, nothing submitted on-chain. **The buyer is not charged.**
   - **`< 400`** → settle on-chain (facilitator `/settle`) and attach the receipt header.

This is "settle-on-`2xx`", and it has a counter-intuitive consequence: the naïve "kill a deep agent so a higher one is left out of pocket" cascade produces **no** stranded spend — when an agent returns `5xx`, its upstream payment is simply cancelled and that buyer keeps its money.

Genuine, unrecoverable stranded spend requires a hop that **successfully settles (`2xx`) and then becomes worthless.** The agent in the middle is the one who gets burned: it already paid its downstream provider and got a real on-chain settlement, but it can't turn that result into its own `2xx` sale — so its *upstream* payment is cancelled. It ate a real USDC cost with no revenue and no rollback. That is the headline, and `fetch` is where it happens (see [src/agents/fetchAgent.ts](src/agents/fetchAgent.ts)).

This behavior was confirmed empirically against the installed SDK before the demo was written — see [spike/README.md](spike/README.md), findings (a) and (b).

---

## Architecture

```
                 ┌─────────────────────────────────────────────┐
   user goal ──▶ │  ORCHESTRATOR  (top buyer + dashboard host)  │  :4000
                 │  - holds the per-goal budget + per-payment cap│
                 │  - /ingest: single event funnel for ALL agents│
                 │  - fans events out over one WebSocket         │
                 └───────────────┬─────────────────────────────┘
                                 │ x402 exact (hop 1)  + X-Goal-Id / X-Hop-Depth
                    ┌────────────▼───────────┐
                    │  SEARCH  ($0.02)        │  seller AND buyer        :4001
                    └──────┬──────────────────┘  ──events──▶ /ingest
                           │ x402 exact (hop 2)
              ┌────────────▼───────────┐
              │  FETCH  ($0.01)         │  seller AND buyer            :4002
              └──────┬──────────────────┘  ──events──▶ /ingest   ◀── strands money here
                     │ x402 exact (hop 3)
        ┌────────────▼───────────┐
        │  VERIFY  ($0.005)       │  terminal seller                 :4003
        └─────────────────────────┘  ──events──▶ /ingest
```

Each agent is a small Express server. **Non-terminal agents are both a seller** (a 402-gated route via `@x402/express`) **and a buyer** (their own `x402Client` calling the next agent down). That recursion is the whole demo. Every hop uses the **`exact`** scheme, which is gasless for the payer — the facilitator submits the ERC-3009 transfer and sponsors gas — so agents need only testnet USDC, no ETH.

| Agent | Port | Role | Base price | Notes |
|-------|------|------|-----------|-------|
| **orchestrator** | 4000 | top buyer, event hub, dashboard host | — (pure buyer) | only directly pays hop 1 |
| **search** | 4001 | seller + buyer | $0.02 | forwards failure; no stranded-spend rule of its own |
| **fetch** | 4002 | seller + buyer | $0.01 | **the agent that strands money** when verify degrades |
| **verify** | 4003 | terminal seller | $0.005 | `ok` / `degraded` / `error` mode toggle drives the demos |

Base chain total at zero load: **$0.02 + $0.01 + $0.005 = $0.035**, deliberately set *above* the orchestrator's **$0.03** per-goal cap so the composition gap shows even without surging.

---

## How it works

A few design decisions are load-bearing. Each one fixes a real bug that a naïve implementation would hit.

### One event funnel, in-band totals
Four agents are four separate Node processes, so an in-process event bus would never reach the dashboard. Instead every agent POSTs its events to the orchestrator's `/ingest`, and the orchestrator runs a **single `emit()` funnel** ([src/orchestrator/server.ts](src/orchestrator/server.ts)) that appends to the log, applies to the `Ledger`, and broadcasts over one WebSocket.

But events are best-effort and can be dropped or arrive late — so they are **not** trusted for the load-bearing numbers. Each seller returns an in-band **`_settlement` summary** ([SettlementSummary](src/shared/types.ts)) in its response body on **both** the `2xx` and `>=400` paths, propagating each subtree's true settled/stranded totals up the synchronous call chain. The event stream feeds the live dashboard and per-agent margins; the in-band summaries back the authoritative chain total and stranded total. A dropped event can therefore never make the budget check undercount what actually moved on-chain.

### Authoritative amounts, never echoes
The buyer ledgers the **exact atomic amount it signed in the 402** (captured in the hop context by the selector), never a recomputed price echo. A concurrent surge can't make the recorded amount diverge from what settled on-chain. See `settledAmountUsd` in [src/shared/buyer.ts](src/shared/buyer.ts).

### Auto-stamped hop headers + recursion guard
Every outbound call carries `X-Goal-Id` (to correlate one run) and `X-Hop-Depth` (incremented per hop). The buyer's `pay()` wrapper stamps both from an `AsyncLocalStorage` hop context ([src/shared/hops.ts](src/shared/hops.ts)), so no agent can forget them and they survive the x402 wrapper's automatic 402→paid retry. Every seller rejects (`400`) anything past `MAX_HOP_DEPTH` *before* the payment dance, so a mis-wired loop can't recurse forever — and a malformed/non-numeric depth header trips the guard rather than silently resetting to 0.

### Two caps, and the gap between them
- **Per-payment cap** lives in the buyer's selector ([src/shared/buyer.ts](src/shared/buyer.ts)): it rejects any 402 option above the ceiling (v2 has no `maxValue` arg) and otherwise picks the cheapest affordable option. Set to `50_000n` atomic = **$0.05**.
- **Per-goal cap** lives in `BudgetGuard` ([src/orchestrator/budget.ts](src/orchestrator/budget.ts)), keyed by `goalId` (not a singleton — concurrent goals would clobber each other). It can only enforce the hop the orchestrator directly pays. It has no veto over `search→fetch→verify`. The `Ledger` reconstructs the true chain total, and the gap between "what I could enforce" and "what actually settled" is exactly the point.

### Dynamic pricing
Each seller prices per request via the native x402 v2 `DynamicPrice` callback ([src/shared/paywall.ts](src/shared/paywall.ts)). A `/surge` knob bumps a per-process load counter ([src/shared/pricing.ts](src/shared/pricing.ts)); the next 402 reflects it (up to +50%). Load bumps happen *after* responding so they affect the next goal, not the in-flight quote.

---

## Project layout

```
cascade/
├── cascade-x402-plan.md        # the full design doc (background, SDK findings, stretch tracks)
├── .env.example                # documents required env vars; copy to .env
├── package.json                # ESM, tsx run scripts
├── tsconfig.json               # ES2022 / ESNext / Bundler resolution, strict
├── spike/                      # step-0 spike: verify the SDK's behavior before building
│   ├── README.md               #   the four load-bearing findings (a)–(d)
│   ├── introspect.ts           #   print the real @x402/* export surface
│   ├── facilitator.ts          #   build + auth the CDP facilitator client
│   ├── seller.ts               #   one exact 402 route with a fail-mode toggle
│   └── buyer.ts                 #   pay it; print decoded SettleResponse + balance delta
└── src/
    ├── shared/
    │   ├── types.ts            # CascadeEvent union + SettlementSummary (in-band totals)
    │   ├── buyer.ts            # makeBuyer(): spend-cap selector, receipt decode, authoritative amount
    │   ├── paywall.ts          # makePaywall(): 402-gated middleware with per-request dynamic price
    │   ├── facilitator.ts      # CDP v2 facilitator (JWT auth) or a no-auth self-hosted one
    │   ├── pricing.ts          # per-process load + surge → price
    │   ├── hops.ts             # X-Goal-Id / X-Hop-Depth context + recursion guard
    │   └── report.ts           # reportEvent(): POST events to /ingest (best-effort)
    ├── agents/
    │   ├── verify.ts           # terminal seller; ok/degraded/error mode toggle  (:4003)
    │   ├── fetchAgent.ts       # recursive middle agent; produces stranded spend  (:4002)
    │   └── search.ts           # recursive agent one level up                     (:4001)
    ├── orchestrator/
    │   ├── server.ts           # top buyer, single emit() funnel, WS fan-out, /goal  (:4000)
    │   ├── ledger.ts           # per-goal chain total, stranded total, per-agent margins
    │   └── budget.ts           # per-goal BudgetGuard (the per-payment ≠ per-goal demo)
    └── dashboard/              # static page served by the orchestrator (see status below)
```

---

## Setup

### 1. Prerequisites
- **Node** (with `npx`/`tsx` — the run scripts use `tsx`, not `ts-node`).
- Four **Base Sepolia testnet wallets** — one per agent. Generate four throwaway hex private keys yourself; never paste a private key into a tool.
- **Testnet USDC** in each wallet. Use Circle's faucet at [faucet.circle.com](https://faucet.circle.com) (select Base Sepolia). The orchestrator spends the most, so fund it generously. No ETH is needed for the `exact` scheme (the facilitator sponsors gas).
- **CDP API credentials** for the facilitator — get `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` from the [Coinbase Developer Platform](https://portal.cdp.coinbase.com/) portal. (Alternatively, point at a no-auth self-hosted v2 facilitator via `FACILITATOR_URL` — see below.)

### 2. Install
```bash
npm install
```

### 3. Configure
Copy [.env.example](.env.example) to `.env` and fill it in. `.env` is gitignored — never commit real keys.

| Variable | Purpose |
|----------|---------|
| `ORCH_PRIVATE_KEY` | orchestrator's funded buyer wallet |
| `SEARCH_PRIVATE_KEY` / `SEARCH_PAY_TO` | search's wallet (buyer key) + the address it receives payment at |
| `FETCH_PRIVATE_KEY` / `FETCH_PAY_TO` | fetch's wallet + payee address |
| `VERIFY_PRIVATE_KEY` / `VERIFY_PAY_TO` | verify's wallet + payee address |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | CDP facilitator auth (required for the CDP path) |
| `FACILITATOR_URL` | *optional* — set to a no-auth/self-hosted v2 facilitator instead of CDP |
| `NETWORK` | CAIP-2 network id; Base Sepolia = `eip155:84532` (not the v1 string `base-sepolia`) |
| `ORCH_INGEST_URL` | where agents POST events; default `http://localhost:4000/ingest` |
| `EVM_RPC_URL` | optional JSON-RPC for on-chain reads; default `https://sepolia.base.org` |

> The facilitator factory ([src/shared/facilitator.ts](src/shared/facilitator.ts)) uses the CDP v2 facilitator via `@coinbase/x402`'s `createFacilitatorConfig()`, which supplies both the `api.cdp.coinbase.com` URL and the JWT auth. For that path `FACILITATOR_URL` is optional; set it only to use a different, no-auth facilitator.

### 4. (Recommended) Run the spike first
Before running the cascade, confirm the four load-bearing SDK facts against your installed build. See [spike/README.md](spike/README.md):

```bash
npm run spike:introspect      # (c) print the real @x402/* export surface — no keys needed
npm run spike:seller          # seller on :5001 (terminal 1)
npm run spike:buyer           # (a) expect HTTP 200, a tx hash, USDC balance drops (terminal 2)
```

---

## Running the cascade

Start the four agents bottom-up, each in its own terminal:

```bash
npm run verify          # terminal seller          → :4003
npm run fetch           # recursive middle agent    → :4002
npm run search          # recursive agent           → :4001
npm run orchestrator    # top buyer + dashboard host → :4000
```

Then kick off a goal:

```bash
curl -XPOST http://localhost:4000/goal \
  -H 'content-type: application/json' \
  -d '{"goal":"research question here"}'
```

Watch USDC settle down three hops. The response (and the `goal_done`/`goal_failed` event) reports the authoritative `spent` (chain total) and `strandedUsd`.

### Orchestrator endpoints
- `POST /goal` — run one goal; returns `{ ok, goalId, data, spent, strandedUsd }`.
- `POST /ingest` — the single event funnel every agent POSTs to.
- `GET /state` / `GET /state?goalId=…` — pull the event log (alternative to the WS replay).
- `ws://localhost:4000` — live event stream; the orchestrator **replays the full log on every new connection**, so a dashboard refresh is never blank.
- `/` — serves the static dashboard from `src/dashboard/`.

---

## Driving the demo

The contrast between verify's modes is the whole point of settle-on-`2xx`.

```bash
# Flip verify's behavior (POST to the terminal seller, :4003):
curl -XPOST http://localhost:4003/mode/ok          # 200, confidence 0.91 → everything settles cleanly
curl -XPOST http://localhost:4003/mode/degraded    # 200 (SETTLES), confidence 0.05 → fetch strands money
curl -XPOST http://localhost:4003/mode/error       # 500 → payment CANCELLED, no money moves
```

| Mode | verify returns | What happens upstream | Money |
|------|---------------|-----------------------|-------|
| `ok` | `200`, confidence `0.91` | every hop resells → all settle | chain total ≈ $0.035 settles |
| `degraded` | `200`, confidence `0.05` | fetch **paid verify on-chain** but can't resell → returns `5xx` → search's payment to fetch is cancelled | **fetch's payment to verify is stranded** — real tx, no recourse |
| `error` | `500` | middleware cancels the incoming payment everywhere up the chain | **nothing settles** |

`degraded` vs `error` cleanly contrasts *"money stranded (settled then wasted)"* with *"buyer protected (cancelled)."*

### Surge a hop
```bash
curl -XPOST http://localhost:4001/surge    # bump search's price (+5% load step, up to +50%)
curl -XPOST http://localhost:4002/surge    # fetch
curl -XPOST http://localhost:4003/surge    # verify
```
Surge a hop past the per-payment cap to see the selector reject it on the next goal. Surge *between* a buyer's 402 and its paid retry and the `exact` scheme rejects the now-insufficient payment — an intentional limitation demo (`upto` is x402's per-hop answer; it doesn't compose).

### The budget breach, with no surge at all
Because the base chain total ($0.035) already exceeds the orchestrator's $0.03 cap, a plain `ok` run shows the gap: hop 1 stays under the per-payment cap and the orchestrator *records* only what it paid directly, yet the reconstructed chain total blows the goal budget. The orchestrator emits a `budget_exceeded` event it could observe but never enforce.

---

## The composition gap (the headline)

v2 ships real mechanisms for most single-hop problems. Cascade's contribution is showing they **don't compose** across a recursive chain — each wired to a concrete on-screen artifact with real tx hashes.

| # | The composition gap | v2 mechanism that solves it *per hop* | What Cascade shows |
|---|---------------------|----------------------------------------|--------------------|
| 1 | **Sessions don't compose** — a channel is point-to-point | `batch-settlement` channels (deposit once, off-chain vouchers, batch claim) | A 3-hop chain needs a *separate* channel per hop; orchestrator↔search's channel can't cover search↔fetch↔verify |
| 2 | **Refunds don't cascade** | `exact` "refund" = a new business-logic transfer; `batch-settlement` defines cooperative refunds *per channel* | Refunding hop 1 can't trigger refunds on hops 2–3; the deepest settled hop has no party with both the funds and a reason to reverse |
| 3 | **Per-payment cap ≠ per-goal cap** | selector cap / `upto` authorized-max bounds ONE hop | The orchestrator caps hop 1 but has no veto over sub-contractor spend; chain total blows the goal budget |
| 4 | **Accounting amortizes within a channel, not across hops** | `batch-settlement` batch claim collapses many requests into one tx | Cross-hop you still have N independent settlements/receipts |
| 5 | **The quote isn't locked across the round-trip** | `upto` lets the client authorize a max | Surge between a buyer's 402 and its paid retry → `exact` rejects the underpayment |
| 6 | **Latency stacks per hop regardless of scheme** | channels cut on-chain *frequency*, not the serial request chain | 1-hop vs 3-hop wall-clock; per-hop latency by differencing |
| 7 | **Capital lockup compounds per hop** *(v2-specific)* | `batch-settlement` requires an upfront on-chain deposit | A recursive market locks idle USDC in escrow at *every* hop |

> The fail-mode toggle replaces the old "kill the process" trick — it's the only way to produce genuine stranded spend given settle-on-`2xx`, and `error` vs `degraded` cleanly contrasts buyer-protected cancellation with stranded settlement.

A note on **"discovery":** Cascade does **price discovery** (the buyer learns each price from the seller's 402 at call time, and it floats with load) — that is real and in-spec. It does **not** do counterparty discovery: the downstream URLs are hardwired constants. Real service discovery via CDP's Bazaar is a stretch track (see the plan's Appendix D).

---

## Safety rails

- **Testnet only** while building. A recursive loop with a bug fans out into real settlements fast — stay on Base Sepolia.
- **Per-payment ceiling** = the buyer's selector (`50_000n` = $0.05). It rejects any 402 option above the cap.
- **Per-goal ceiling** = `BudgetGuard`, keyed by `goalId` (not a singleton). It only enforces the hop the orchestrator directly pays.
- **Max-hop-depth guard** = `X-Hop-Depth` rejected past `MAX_HOP_DEPTH` *before* the payment dance, so a mis-wired loop can't recurse forever.
- **Keys in `.env`, gitignored.** Commit only `.env.example`. Never log a private key.
- **Facilitator allowance:** the CDP facilitator has a free monthly tx allowance; a recursive market burns it — budget for it.

---

## Implementation status

| Component | Status |
|-----------|--------|
| Step-0 spike (`spike/`) — settlement, settle-vs-cancel, export surface, facilitator auth | ✅ confirmed against the live SDK |
| `shared/` — types, buyer, paywall, facilitator, pricing, hops, report | ✅ implemented |
| Agents — `verify`, `fetchAgent`, `search` | ✅ implemented |
| Orchestrator — `server` (emit funnel + WS + `/goal`), `ledger`, `budget` | ✅ implemented |
| Dashboard (`src/dashboard/`) — payment tree, live ledger, stranded counter, latency histogram, fail-mode buttons | ⏳ not yet built (directory is a placeholder; the orchestrator already serves it statically and replays the WS log so the page won't be blank once added) |
| Stretch — `batch-settlement` channels, cooperative refunds, CDP Bazaar discovery | ⏳ optional tracks (plan Appendices C–D) |

Until the dashboard ships, drive everything via `curl` and read the orchestrator's JSON responses, the `/state` event log, and the per-agent console logs.

---

## Background

The full design doc — including the four SDK findings the spike verified, the seller/buyer/orchestrator walkthroughs, the v2-vs-v1 reasoning, and the stretch tracks — lives in [cascade-x402-plan.md](cascade-x402-plan.md).

**Stack:** TypeScript (ESM, run with `tsx`), Express 5, `@x402/*` v2 (`core`, `evm`, `express`, `fetch`), `@coinbase/x402` for CDP facilitator auth, `viem` for signing, `ws` for the dashboard feed.

**License:** MIT.
