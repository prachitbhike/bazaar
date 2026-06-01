# Cascade — an x402 recursive payment-chain demo (x402 **v2** / `@x402/*`)

**What you're building:** a small ecosystem of paywalled AI micro-services where an orchestrator
agent completes a user goal by *buying from sellers who buy from each other*. Every hop is a real
x402 settlement on Base Sepolia. A live dashboard renders the payment tree, the USDC ledger, a
"stranded spend" counter, and a per-hop latency histogram — and a final panel names each protocol
limitation with the exact transaction that demonstrated it.

The point is to show **composable, multi-hop payments with per-request dynamic pricing** — payments
composing the way HTTP requests compose — which is the actual thesis of x402 and something almost no
public demo shows. Single-agent-pays-single-API is the default sample; this is the frontier.

> **Be precise about "discovery."** Two different things get called "discovery," and the baseline
> demo only does one of them. (a) **Price discovery** — the buyer learns the price at call time from
> the seller's 402 challenge, and it floats with load. That is real, in-spec, and implemented here.
> (b) **Counterparty/service discovery** — finding *which* agent to hire. The baseline **hardwires**
> the topology (downstream URLs are constants in §5/§6), so it does *not* do this. Don't claim it
> does. CDP's **Bazaar** discovery layer is the real mechanism for (b) — `GET /v2/x402/discovery/
> resources` (catalog), `/discovery/search` (semantic), or `facilitatorClient.extensions.discovery.
> listResources()` in the TS SDK; the CDP facilitator auto-catalogs a service the first time it
> settles a payment. Wiring it in is an optional track (Appendix D) and is what would make
> "machine-discovered" literally true.

> **This plan targets x402 v2 (the scoped `@x402/*` packages)** — the current direction of the
> protocol. v2 is much more than renamed v1: it ships pluggable *schemes* (`exact`, `upto`,
> `batch-settlement`) that already solve several things v1 couldn't. That changes the demo's thesis
> (see §0.4 and §11): the interesting story is no longer "x402 can't do refunds/sessions" — v2 *can*,
> per hop — it's that **none of those mechanisms compose across a recursive chain.** That's the
> unsolved frontier, and it's a sharper, more current pitch to the foundation.

---

## 0. Read this first — what was verified against the live SDK (and what will bite you)

Everything below was checked against `github.com/x402-foundation/x402` (June 2026 — the repo **moved
from `coinbase/x402`**). Four facts decide whether the demo works; confirm them with the step-0 spike
(§13) before writing the recursive code.

### 0.1 Settlement is gated on the handler's status code — this *defines* "stranded spend"

The single most important fact. In the v2 Express middleware
(`typescript/packages/http/express/src/index.ts`) the flow is:

1. Verify the incoming payment (facilitator `/verify`).
2. Run the route handler (`next()`), buffering its response.
3. **Wait for the handler to finish, then check the status code:**
   - `res.statusCode >= 400` → `cancellationDispatcher.cancel({ reason: "handler_failed" })`,
     **do not settle.** The buffered error body is sent, but the signed payment authorization is
     never submitted on-chain. **The buyer is not charged.**
   - handler threw → `cancel({ reason: "handler_threw" })`, same outcome.
   - status `< 400` → settle on-chain (facilitator `/settle`), attach the `X-PAYMENT-RESPONSE`
     header. If settlement *itself* fails, the handler's body is dropped and a settlement-failure
     response is returned instead.

**Consequence:** the naïve "kill verify mid-run, fetch was already paid by search" cascade produces
**no stranded spend** — when fetch returns `502`, the middleware *cancels* the search→fetch payment,
so search keeps its money. Genuine, on-chain stranded spend requires a hop that **successfully
settles (`2xx`) and then becomes worthless**. The agent in the middle is the one who gets burned: it
already paid downstream and got a `2xx` settlement, then can't turn that into its own `2xx` sale, so
its *upstream* payment is cancelled. It ate a real, unrecoverable USDC cost — no rollback. That is
what §6 and §11 demonstrate. (The spike in §13 confirms this empirically for your installed build.)

### 0.2 Each agent is a separate process, so an in-process event bus never reaches the dashboard

Four agents = four Node processes. An in-process `EventEmitter` in `shared/` gives each process its
*own* instance; the orchestrator's WebSocket would only ever see the orchestrator's own events, and
the dashboard tree/ledger/stranded counter would be nearly empty. Fix: every agent POSTs its events
to the orchestrator's `/ingest` endpoint; the orchestrator owns the single WebSocket fan-out (§7).
**Await the POST** for settlement events (`hop_settled`/`stranded`) so per-goal totals are complete
when the nested call chain unwinds (§7); the rest can be fire-and-forget. Every event carries a
`goalId` (§3.1) so the dashboard correlates one run.

### 0.3 Route price is static at config time — dynamic pricing needs a per-request shim

The v2 route config is `{ accepts: PaymentRequirements[], description?, mimeType? }` and `price`/
`amount` is fixed when the config object is built. You can't "rebuild middleware on an interval"
either — the Express stack is frozen after `app.use(...)`. Fix: wrap the payment middleware in a thin
shim that rebuilds the *routes* object (with a freshly computed price) per request (§5). (v2's
*protocol-native* path for variable pricing is the `upto`/`batch-settlement` "authorize a max, settle
the actual amount" partial-settlement model — noted in §8/§11, but the shim is simpler for the surge
knob and works with the plain `exact` scheme.)

> **Quote-coherence gotcha:** the 402 quote is **not locked**. The buyer signs a payment for the
> price it saw in the 402, then retries; the shim recomputes the price on the retry. If load (or a
> surge) moved the price *between* the 402 and the paid retry, the `exact` scheme rejects the now-
> insufficient payment. Keep load bumps out of the in-flight path (bump on settlement / for the
> *next* goal), and treat "surge mid-flight → insufficient payment" as an intentional limitation
> demo (§11), not a bug. The `upto` scheme is x402's answer to this — another tie-in.

### 0.4 v2 already solves most of the original "limitations" — *per hop*. The story is composition.

The repo ships, as first-class EVM schemes:

- **`batch-settlement`** (`@x402/evm/batch-settlement`): stateless unidirectional **payment channels**
  — deposit once, sign off-chain cumulative vouchers per request, claim in batches. This *is* a
  session, and it amortizes per-payment accounting. It also natively supports **dynamic pricing**
  ("client authorizes a max per-request, server charges only what was used") and the scheme **defines
  cooperative refunds + timed withdrawals from channel escrow** (fees paid by the intermediary).
- **`upto`** + **partial settlement** (`setSettlementOverrides(res, { amount })`): the client
  authorizes a maximum and the server settles ≤ that amount — variable/metered pricing in one hop.

Refunds need a precise claim, because there are three different "refund" stories at different
maturity levels (verify the exact state in the step-0 spike and the x402 FAQ before you pitch any of
them):

- **`exact`** payments are irreversible push transfers. A "refund" is **business logic** — the seller
  sends a *new* token transfer back. There is no protocol rollback.
- **`batch-settlement`** has **cooperative refunds** defined in the scheme spec — the live, native
  refund path in v2.
- **`auth-capture`** (escrow with capture/void/refund, linked to the x402r refund extension) is
  **emerging, not first-class-live**: the package ships the **client only**; server + facilitator
  support "follow in a later change." Treat it as a roadmap item, not a demo dependency.

So "x402 has no sessions / no refunds / no spend flexibility" is **false for v2 at the single-hop
level.** The honest, more impressive demo shows that a payment channel is point-to-point
(orchestrator↔search), a refund (business-logic or cooperative) is per-payment, and an `upto` max
bounds one hop — **and none of it composes** across orchestrator→search→fetch→verify. §11 is rebuilt
around that.

### 0.5 SDK is fast-moving — every snippet below is **shape-only**; reconcile with the spike

The code in §5–§7 expresses *intent*, not guaranteed-current syntax. The packages publish more than
one valid form for the same thing, and the docs and the repo aren't always in sync. The clearest
example — scheme registration on the buyer has **two equivalent forms**, both currently documented:

```ts
// Form A — direct register (used by the repo's own TS example, and Go/Python):
import { ExactEvmScheme } from "@x402/evm/exact/client";
client.register("eip155:*", new ExactEvmScheme(signer, rpcOptions));

// Form B — helper (used by CDP's TS buyer quickstart):
import { registerExactEvmScheme } from "@x402/evm/exact/client";
registerExactEvmScheme(client, { signer });
```

Pick whichever the step-0 spike confirms is exported. After install, print what's actually there and
adapt:

```bash
node -e "import('@x402/express').then(m=>console.log(Object.keys(m)))"
node -e "import('@x402/fetch').then(m=>console.log(Object.keys(m)))"
node -e "import('@x402/evm/exact/server').then(m=>console.log(Object.keys(m)))"
node -e "import('@x402/evm/exact/client').then(m=>console.log(Object.keys(m)))"
```

---

## 1. Architecture

```
                 ┌─────────────────────────────────────────────┐
   user goal ──▶ │  ORCHESTRATOR (buyer agent + dashboard host) │
                 │  - holds USDC budget, per-payment spend cap  │
                 │  - /ingest: receives events from all agents  │
                 │  - fans events out over WebSocket            │
                 └───────────────┬─────────────────────────────┘
                                 │ x402 exact (hop 1)  + X-Goal-Id
                    ┌────────────▼───────────┐
                    │  SEARCH agent  ($)      │  seller AND buyer
                    │  needs raw pages →      │  ──events──▶ /ingest
                    └──────┬──────────────────┘
                           │ x402 exact (hop 2) + X-Goal-Id
              ┌────────────▼───────────┐
              │  FETCH agent  ($)       │  seller AND buyer
              │  needs verification →   │  ──events──▶ /ingest
              └──────┬──────────────────┘
                     │ x402 exact (hop 3) + X-Goal-Id
        ┌────────────▼───────────┐
        │  VERIFY agent  ($)      │  terminal seller
        └─────────────────────────┘  ──events──▶ /ingest
```

Each agent is a tiny Express server. Non-terminal agents are **both** a seller (a 402-gated route
via `@x402/express`) **and** a buyer (their own `x402Client` + `wrapFetchWithPayment` calling the next
agent down). That recursion is the whole demo. The baseline uses the **`exact`** scheme on every hop;
an optional stretch track (Appendix C) swaps the top hop to `batch-settlement` to show channel
deposits and capital lockup.

**Wallets:** each agent gets its own Base Sepolia key + address, funded with testnet **USDC**. The
`exact` scheme is gasless for the payer (ERC-3009 `transferWithAuthorization` — the **facilitator**
submits the tx and sponsors gas), so you generally do **not** need to fund agents with ETH. (The
`batch-settlement` stretch is different: the client makes an on-chain *deposit* and so needs ETH for
that tx — see Appendix C.) Margin = (price an agent charges) − (price it pays downstream); show it
live.

---

## 2. Repo layout

```
cascade/
├── package.json
├── tsconfig.json            # ESM: "module":"ESNext", "moduleResolution":"Bundler"
├── .env                     # never commit; testnet keys only
├── .env.example             # committed; documents vars, no secrets
├── .gitignore
├── src/
│   ├── shared/
│   │   ├── types.ts         # event + ledger types (every event carries goalId)
│   │   ├── report.ts        # reportEvent(): POST event to orchestrator /ingest
│   │   ├── pricing.ts       # dynamic price function + per-process load state
│   │   ├── dynamicPaywall.ts# per-request priced @x402/express middleware shim (§5)
│   │   └── buyer.ts         # x402Client + spend-cap selector + receipt reader (§6)
│   ├── agents/
│   │   ├── verify.ts        # terminal seller          (port 4003)
│   │   ├── fetchAgent.ts    # seller + buyer of verify (port 4002)
│   │   └── search.ts        # seller + buyer of fetch   (port 4001)
│   ├── orchestrator/
│   │   ├── server.ts        # buyer + /ingest + dashboard host (port 4000)
│   │   ├── ledger.ts        # per-goalId spend/margin aggregation
│   │   └── budget.ts        # spend-cap guard (the limitation demo)
│   └── dashboard/
│       └── index.html       # live tree + ledger + limitations panel
└── README.md
```

---

## 3. Environment

`.env` (Base Sepolia, testnet only — never put a mainnet key in here):

```
# One wallet per agent. Generate 4 throwaway keys (hex, 0x-prefixed).
ORCH_PRIVATE_KEY=0x...
SEARCH_PRIVATE_KEY=0x...
SEARCH_PAY_TO=0x...
FETCH_PRIVATE_KEY=0x...
FETCH_PAY_TO=0x...
VERIFY_PRIVATE_KEY=0x...
VERIFY_PAY_TO=0x...

# Facilitator that speaks the x402 v2 protocol on Base Sepolia. Confirm v2 support in the
# step-0 spike. CDP v2 endpoint (recommended; needs CDP API keys; free monthly tx allowance):
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
# (The community x402.org facilitator may be v1-only — verify before relying on it for v2.)

# Where agents POST their events so the dashboard can see them (§0.2).
ORCH_INGEST_URL=http://localhost:4000/ingest

# CAIP-2 network id. Base Sepolia = eip155:84532 (NOT the v1 string "base-sepolia").
NETWORK=eip155:84532

# Optional JSON-RPC for on-chain reads (only needed by gas-sponsoring extensions or the
# batch-settlement stretch; the plain exact scheme does not require it).
EVM_RPC_URL=https://sepolia.base.org
```

Fund each wallet with Base Sepolia testnet **USDC** (Circle faucet, Appendix A). ETH is generally not
needed for the `exact` scheme (facilitator sponsors gas) — confirm for your facilitator.

> **Prohibited-action note:** generating keys and funding wallets is something *you* do, not the
> agent — never paste a private key into a form or hand it to a tool. Keys live in `.env`
> (gitignored). Commit only `.env.example`.

### 3.1 Correlate everything with a `goalId`

The orchestrator mints a short `goalId` per `/goal` run and passes it downstream as an `X-Goal-Id`
header on every paid call. Each agent forwards it on its own downstream call and stamps it on every
event. The dashboard groups the tree, ledger, counters, and per-goal budget by `goalId` — this makes
concurrent runs correct rather than a global free-for-all.

---

## 4. Dependencies

```bash
npm init -y
# v2 scoped packages. @x402/core is a peer of the others.
npm install @x402/express @x402/fetch @x402/evm @x402/core express ws viem dotenv
# tsx, not ts-node: these packages are ESM-only and ts-node's default CJS mode chokes on them.
npm install -D typescript tsx @types/express @types/node @types/ws
npx tsc --init   # then set "module":"ESNext", "moduleResolution":"Bundler", "target":"ES2022"
```

Set `"type": "module"` in `package.json` (or run everything via `tsx`, which handles ESM regardless).

---

## 5. The seller side (terminal agent: `verify.ts`)

Pure seller, no downstream purchase. Dynamic pricing is done with a **per-request shim** (§0.3) so the
402 amount tracks current load.

```ts
// shared/dynamicPaywall.ts — rebuilds the priced routes per request so the 402 amount
// reflects CURRENT load, not the price frozen at process-start.
import type { RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

export function dynamicPaywall(opts: {
  routeKey: string;                 // e.g. "GET /verify"
  payTo: `0x${string}`;
  network: string;                  // "eip155:84532"
  priceNow: () => `$${string}`;     // called fresh on every request
  description: string;
  facilitatorUrl: string;
}): RequestHandler {
  // The resource server is price-independent, so build it once.
  const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(opts.network, new ExactEvmScheme());

  return (req, res, next) => {
    const mw = paymentMiddleware(
      {
        [opts.routeKey]: {
          accepts: [
            { scheme: "exact", price: opts.priceNow(), network: opts.network, payTo: opts.payTo },
          ],
          description: opts.description,
          mimeType: "application/json",
        },
      },
      resourceServer,
    );
    return (mw as unknown as RequestHandler)(req, res, next);
  };
}
```

```ts
// agents/verify.ts
import "dotenv/config";
import express from "express";
import { dynamicPaywall } from "../shared/dynamicPaywall";
import { priceFor, priceForUsd, bumpLoad } from "../shared/pricing";
import { reportEvent } from "../shared/report";

const app = express();
const PAY_TO = process.env.VERIFY_PAY_TO as `0x${string}`;

// fail-mode toggle for the limitation demos (§11). CRITICAL: "degraded" returns 200 so the
// payment SETTLES (that's how money gets stranded one hop up). "error" returns 500 so the
// middleware CANCELS — no money moves. The two modes show OPPOSITE protocol behaviors (§0.1).
let mode: "ok" | "degraded" | "error" = "ok";
app.post("/mode/:m", (req, res) => { mode = req.params.m as any; res.json({ mode }); });

// per-process surge knob (§8) — must live on THIS seller's process, not the orchestrator.
app.post("/surge", (_req, res) => { bumpLoad("verify", 5); res.json({ ok: true }); });

app.use(
  dynamicPaywall({
    routeKey: "GET /verify", payTo: PAY_TO, network: process.env.NETWORK!,
    priceNow: () => priceFor("verify"),
    description: "Verify a claim/source", facilitatorUrl: process.env.FACILITATOR_URL!,
  }),
);

app.get("/verify", (req, res) => {
  const goalId = req.header("X-Goal-Id") ?? "?";
  if (mode === "error") {
    reportEvent({ type: "work_failed", agent: "verify", goalId, detail: "forced 500" });
    return res.status(500).json({ error: "verify failed" });   // >=400 → payment cancelled
  }
  const degraded = mode === "degraded";
  reportEvent({ type: "work_done", agent: "verify", goalId,
    detail: degraded ? "verified (LOW confidence)" : "verified source" });
  // 200 → settles. Echo the quoted price in-band so the buyer can ledger the exact charge
  // (the SettleResponse only carries `amount` for upto-style schemes, not exact).
  res.json({ verified: !degraded, confidence: degraded ? 0.05 : 0.91, _priceUsd: priceForUsd("verify") });
  bumpLoad("verify");   // bump AFTER responding → affects the NEXT goal, not this in-flight quote (§0.3)
});

app.listen(4003, () => console.log("verify agent on :4003"));
```

---

## 6. The recursive middle agent (`fetchAgent.ts`) — seller **and** buyer

The heart of the demo: it gets paid, then **pays the verify agent**, inside one request — and it's
where genuine stranded spend is produced. Read §0.1 first; the error handling is load-bearing.

```ts
// shared/buyer.ts — an x402Client whose SELECTOR enforces a per-payment spend cap.
// v2 has no `maxValue` arg on wrapFetchWithPayment; the cap lives in the selector that
// chooses among the 402's `accepts[]` options (each has `.amount` in atomic units).
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import type { SettleResponse } from "@x402/core/types"; // confirm export path at runtime

export function makeBuyer(privateKey: `0x${string}`, capAtomic: bigint, rpcUrl?: string) {
  const signer = privateKeyToAccount(privateKey);

  // SelectPaymentRequirements: (x402Version, accepts[]) => chosen requirement.
  // Throw if every option exceeds the cap — that's the per-payment ceiling.
  const selector = (_v: number, accepts: any[]) => {
    const affordable = accepts.filter(r => BigInt(r.amount) <= capAtomic);
    if (affordable.length === 0) {
      throw new Error(`all ${accepts.length} payment options exceed per-payment cap ${capAtomic}`);
    }
    return affordable.reduce((a, b) => (BigInt(a.amount) <= BigInt(b.amount) ? a : b)); // cheapest
  };

  const client = new x402Client(selector);
  client.register("eip155:*", new ExactEvmScheme(signer, rpcUrl ? { rpcUrl } : undefined));

  const pay = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);
  const readReceipt = (res: Response): SettleResponse | undefined =>
    httpClient.getPaymentSettleResponse((n: string) => res.headers.get(n));

  return { pay, readReceipt };
}
```

```ts
// agents/fetchAgent.ts
import "dotenv/config";
import express from "express";
import { dynamicPaywall } from "../shared/dynamicPaywall";
import { makeBuyer } from "../shared/buyer";
import { priceFor, priceForUsd, bumpLoad } from "../shared/pricing";
import { reportEvent } from "../shared/report";

const app = express();
const PAY_TO = process.env.FETCH_PAY_TO as `0x${string}`;
const VERIFY_URL = "http://localhost:4003/verify";

// per-payment cap: 50000 atomic = $0.05 (USDC has 6 decimals).
const { pay, readReceipt } = makeBuyer(process.env.FETCH_PRIVATE_KEY as `0x${string}`, 50_000n, process.env.EVM_RPC_URL);

app.post("/surge", (_req, res) => { bumpLoad("fetch", 5); res.json({ ok: true }); });

app.use(dynamicPaywall({
  routeKey: "GET /fetch", payTo: PAY_TO, network: process.env.NETWORK!,
  priceNow: () => priceFor("fetch"),
  description: "Fetch + clean a page, with verification", facilitatorUrl: process.env.FACILITATOR_URL!,
}));

app.get("/fetch", async (req, res) => {
  const goalId = req.header("X-Goal-Id") ?? "?";
  const t0 = Date.now();
  try {
    reportEvent({ type: "work_done", agent: "fetch", goalId, detail: "fetched + cleaned page" });
    reportEvent({ type: "hop_start", from: "fetch", to: "verify", goalId });

    const r = await pay(VERIFY_URL, { method: "GET", headers: { "X-Goal-Id": goalId } });

    // verify returned >=400 ⇒ the middleware CANCELLED our payment (we paid nothing) but we have
    // nothing to sell. Propagate as our own failure (which cancels OUR upstream payment too).
    if (!r.ok) throw new Error(`verify returned ${r.status}`);

    const verification = await r.json();
    const receipt = readReceipt(r);                       // tx hash = on-chain proof of settlement
    const paidUsd = verification._priceUsd ?? 0;          // exact charge, echoed in-band (§5)
    reportEvent({ type: "hop_settled", from: "fetch", to: "verify", goalId,
      amountUsd: paidUsd, tx: receipt?.transaction, latencyMs: Date.now() - t0 });

    // BUSINESS RULE that creates GENUINE stranded spend (§11, verify mode "degraded"):
    // we already SETTLED with verify (real USDC, tx exists), but the result is unusable, so we
    // can't sell it upstream → we return 5xx → search's payment to us is CANCELLED. We are out of
    // pocket to verify, no revenue, no rollback. The protocol offers no recourse.
    if (verification.confidence < 0.5) {
      reportEvent({ type: "stranded", agent: "fetch", goalId, amountUsd: paidUsd, tx: receipt?.transaction,
        reason: "paid verify (settled), result unusable, cannot resell" });
      return res.status(502).json({ error: "verification unusable", stranded: true });
    }

    res.json({ page: "…cleaned content…", verification, _priceUsd: priceForUsd("fetch") });
    bumpLoad("fetch");
  } catch (err: any) {
    reportEvent({ type: "hop_failed", from: "fetch", to: "verify", goalId, reason: String(err?.message ?? err) });
    res.status(502).json({ error: "downstream verification failed" });   // cancels search→fetch
  }
});

app.listen(4002, () => console.log("fetch agent on :4002"));
```

`search.ts` is the same pattern: seller on `GET /search`, buyer that pays `http://localhost:4002/fetch`.
Copy `fetchAgent.ts`, rename, repoint the downstream URL/env vars, propagate `X-Goal-Id`, echo
`_priceUsd: priceForUsd("search")`.

> **The corrected stranded-spend story.** Because settlement is gated on a `2xx` (§0.1), the money
> that strands is always the *deepest successful settlement that becomes worthless*. In "degraded"
> mode: `fetch→verify` settles (real tx) but `search→fetch` is cancelled — **fetch** eats the loss,
> and no v2 mechanism claws it back: an `exact` refund would be a *new* business-logic transfer from
> verify (which has no reason to issue it), and even a `batch-settlement` cooperative refund is
> per-channel and per-payment — neither cascades up the chain (see §11). That *is* the "no atomic
> cross-hop rollback" limitation, demonstrated honestly.

---

## 7. The orchestrator (`orchestrator/server.ts`) — top buyer + dashboard host + event hub

```ts
import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";
import path from "path";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { makeBuyer } from "../shared/buyer";
import { Ledger } from "./ledger";
import { BudgetGuard } from "./budget";

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const ledger = new Ledger();                       // per-goalId spend + margin
const eventLog: any[] = [];                        // append-only history (per-process, in-memory)

// SINGLE funnel for EVERY event — the orchestrator's own AND the agents'. The bug to avoid:
// broadcasting orchestrator events without also calling ledger.apply() drops hop 1
// (orchestrator→search) from ledger.total(). Routing everything through emit() fixes that.
function emit(evt: any) {
  eventLog.push(evt);
  ledger.apply(evt);
  const msg = JSON.stringify(evt);
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
}

// Refresh fix: a WebSocket broadcast is ephemeral, so a new/refreshed dashboard would see an
// empty screen. Replay the log on connect (and expose /state as an explicit pull alternative).
wss.on("connection", ws => { for (const evt of eventLog) ws.send(JSON.stringify(evt)); });
app.get("/state", (req, res) => {
  const goalId = req.query.goalId as string | undefined;
  res.json(goalId ? eventLog.filter(e => e.goalId === goalId) : eventLog);
});

// event hub: every agent POSTs its events here (§0.2); they flow through the same emit()
app.post("/ingest", express.json(), (req, res) => { emit(req.body); res.sendStatus(204); });

const { pay, readReceipt } = makeBuyer(process.env.ORCH_PRIVATE_KEY as `0x${string}`, 50_000n, process.env.EVM_RPC_URL);
const budgets = new Map<string, BudgetGuard>();    // keyed by goalId, NOT a singleton (§12)

app.use(express.static(path.join(__dirname, "..", "dashboard")));

app.post("/goal", express.json(), async (req, res) => {
  const goalId = randomUUID().slice(0, 8);
  // Cap is set BELOW the natural base chain total ($0.02 + $0.01 + $0.005 = $0.035) so the overage
  // shows WITHOUT surging. Surge to make it more dramatic. (§11 row 3, §12)
  const budget = new BudgetGuard(0.03);
  budgets.set(goalId, budget);
  emit({ type: "goal_start", goalId, goal: req.body?.goal ?? "demo goal", capUsd: budget.capUsd });
  emit({ type: "hop_start", from: "orchestrator", to: "search", goalId });
  try {
    const r = await pay("http://localhost:4001/search", { method: "GET", headers: { "X-Goal-Id": goalId } });
    if (!r.ok) throw new Error(`search returned ${r.status}`);

    const data = await r.json();
    const receipt = readReceipt(r);
    const paid = data._priceUsd ?? 0;
    budget.record(paid);                            // enforces HOP 1 ONLY — see the caveat below
    emit({ type: "hop_settled", from: "orchestrator", to: "search", goalId,
      amountUsd: paid, tx: receipt?.transaction });

    // The breach is detectable only AFTER the fact, against the reconstructed chain total
    // (observability, not enforcement). Requires agents to await their /ingest POST so the
    // ledger is complete by the time the nested call chain unwinds (see report.ts note, §0.2).
    const chainTotal = ledger.total(goalId);
    if (chainTotal > budget.capUsd) {
      emit({ type: "budget_exceeded", goalId, capUsd: budget.capUsd, chainTotalUsd: chainTotal,
        enforcedUsd: budget.spent, detail: "goal cap blown by lower hops the orchestrator could not veto" });
    }
    emit({ type: "goal_done", goalId, result: data, spent: chainTotal });
    res.json({ ok: true, goalId, data, spent: chainTotal });
  } catch (err: any) {
    emit({ type: "goal_failed", goalId, reason: String(err?.message ?? err), spent: ledger.total(goalId) });
    res.status(502).json({ ok: false, goalId, error: String(err?.message ?? err) });
  }
});

httpServer.listen(4000, () => console.log("orchestrator + dashboard on http://localhost:4000"));
```

> **Event ordering for accurate totals.** The call chain is strictly nested (orchestrator awaits
> search awaits fetch awaits verify), so make `reportEvent` **await** its `/ingest` POST before the
> agent sends its response. That guarantees every downstream `hop_settled`/`stranded` event is in the
> ledger by the time control unwinds back to the orchestrator, so `ledger.total(goalId)` is complete
> when the budget check runs. (localhost POST, negligible cost.) If you'd rather keep `reportEvent`
> fire-and-forget, move the `budget_exceeded` flag into the dashboard, which sees the full stream.

### The budget guard (`orchestrator/budget.ts`) — this *is* a limitation demo

```ts
// x402 authorizes ONE transfer for ONE resource. Even with the v2 `upto` scheme, the buyer can
// only bound a SINGLE hop ("pay at most $X to THIS seller"). There is no protocol notion of
// "spend at most $X across this whole goal/chain." So the goal cap lives in OUR code — and,
// crucially, the orchestrator can only enforce it at the hop IT pays. Once it has paid search,
// it has no visibility into or veto over search→fetch→verify.
export class BudgetGuard {
  spent = 0;
  constructor(public capUsd: number) {}
  record(amountUsd: number) {
    this.spent += amountUsd;
    if (this.spent > this.capUsd) throw new Error(`BUDGET EXCEEDED: $${this.spent.toFixed(4)} > $${this.capUsd}`);
  }
}
```

**The visibility caveat — the whole point of limitation #3.** `budget.record()` only sees **hop 1**
(orchestrator→search, $0.02), so it never throws against the $0.03 cap — the orchestrator literally
*cannot* enforce a goal budget, because it has no protocol hook on the hops it didn't directly pay.
The **true** chain total ($0.035 at base load) is reconstructed by the `Ledger` from the `/ingest`
events (`ledger.total(goalId)`) and flagged with a `budget_exceeded` event — but that's
*observability*, not *enforcement*: by the time those receipts arrive, the lower-hop money is already
gone. The per-payment cap (the selector in §6, or an `upto` max) holds on each hop; nothing bounds the
chain. Show both numbers side by side: hop-1 cap respected ($0.02 ≤ $0.03), chain total blew past it
($0.035 > $0.03), and the orchestrator had no lever to stop it.

---

## 8. Dynamic pricing (`shared/pricing.ts`)

```ts
// Per-process state: each agent runs in its own process, so each owns its load map.
// /surge therefore lives on the SELLER's process (§5), never the orchestrator (§0.2).
const load: Record<string, number> = { search: 0, fetch: 0, verify: 0 };
const BASE: Record<string, number> = { search: 0.02, fetch: 0.01, verify: 0.005 };

export function bumpLoad(agent: string, by = 1) { load[agent] = (load[agent] ?? 0) + by; }

export function priceForUsd(agent: string): number {
  const surge = 1 + Math.min(load[agent] ?? 0, 10) * 0.05;   // up to +50%
  return +(BASE[agent] * surge).toFixed(4);
}
export function priceFor(agent: string): `$${string}` {
  return `$${priceForUsd(agent)}` as `$${string}`;
}
```

The dashboard's "congestion" button POSTs to the specific seller's `/surge` (e.g. `:4003/surge`).
Because the shim reads `priceFor()` per request, the next 402 reflects the spike.

> **Surge × cap × quote coherence.** If a spike pushes a hop above the buyer's per-payment cap, the
> selector (§6) throws and the hop fails — a clean on-screen demo of the per-payment ceiling. If a
> spike lands *between* a buyer's 402 and its paid retry, the `exact` scheme rejects the now-
> insufficient payment (§0.3) — a clean demo of "the quote isn't locked." Decide which you're
> showing. The protocol-native fix for variable pricing is the `upto`/`batch-settlement` partial-
> settlement model (authorize a max, settle the actual) — call that out (§11).

---

## 9. The dashboard (`dashboard/index.html`)

Single screen, WebSocket-fed (`ws://localhost:4000`), vanilla JS + a little SVG/canvas. All live
state is rebuilt from the event stream, keyed by `goalId`. **A refresh is safe because the
orchestrator replays its event log on every new WebSocket connection** (§7) — plain broadcast is
ephemeral and would otherwise leave a refreshed page blank; if you prefer a pull, fetch `/state` (or
`/state?goalId=…`) on load before opening the socket. Regions:

1. **Payment tree** — nodes for orchestrator/search/fetch/verify; animate an edge on each
   `hop_start` → `hop_settled` pair; label edges with settled USDC + tx hash. On `stranded`, flag the
   *settled* edge and turn the agent that ate the loss red.
2. **Live ledger** — every settlement: payer → payee, amount, tx, running per-goal total, and each
   agent's **margin** (its `_priceUsd` minus what it paid downstream — both available now that all
   hops report via `/ingest`).
3. **Stranded-spend counter** — sum of `stranded` event `amountUsd`: USDC that **settled on-chain**
   but produced no usable result and cannot be recovered. The headline, demonstrated truthfully.
4. **Latency histogram by hop-depth** — bucket `latencyMs` by depth (1/2/3); shows latency stacking.

Plus a **"What broke and why" panel** populated from real events (§11), and **fail-mode toggle**
buttons (POST `:4003/mode/ok|degraded|error`).

> The dashboard is a normal static page served by Express via `path.join(__dirname, ...)` (so the run
> directory doesn't matter); keep all live state in memory / from the WebSocket.

---

## 10. Run order

```bash
# four terminals (or a `concurrently` script). tsx, not ts-node (§4).
npx tsx src/agents/verify.ts        # :4003
npx tsx src/agents/fetchAgent.ts    # :4002
npx tsx src/agents/search.ts        # :4001
npx tsx src/orchestrator/server.ts  # :4000  → open http://localhost:4000
```

Hit the dashboard's "Run goal" button (`POST /goal`). Watch USDC flow down three hops. Flip verify to
`degraded` and run again to watch the stranded counter move (with a real tx hash); flip to `error` to
see the opposite — cancellation, no money moved.

---

## 11. The limitations this demo surfaces — framed against what **v2 already solves**

This is the heart of the pitch. v2 ships real mechanisms for most single-hop problems; the demo's
contribution is showing they **don't compose** across a recursive chain. Wire each row to a concrete,
on-screen artifact with real tx hashes.

| # | The composition gap | v2 mechanism that solves it *per hop* | What this demo shows |
|---|---------------------|----------------------------------------|----------------------|
| 1 | **Sessions don't compose.** A channel is point-to-point. | `batch-settlement` channels (deposit once, off-chain vouchers, batch claim) — a real session. | A 3-hop chain needs a *separate* channel per hop; orchestrator↔search's channel can't cover search↔fetch↔verify. Count channels + deposits per goal. |
| 2 | **Refunds don't cascade.** | Live: `exact` "refund" = a *new* business-logic transfer the seller chooses to send; `batch-settlement` defines **cooperative refunds** per channel. (Emerging: `auth-capture` escrow capture/void/refund — **client-only today**, server+facilitator pending; don't pitch it as live.) | Refunding hop 1 can't trigger refunds on hops 2–3; refunds are per-payment/per-channel and uncoordinated; the deepest settled hop has no party with both the funds and a reason to reverse. Show stranded spend (§6) + "a refund here can't claw back there." |
| 3 | **Per-payment cap ≠ per-goal cap.** | Selector cap (§6) / `upto` authorized-max bounds ONE hop. | The orchestrator caps hop 1 but has no veto over sub-contractor spend; reconstructed chain total blows the goal budget. Budget bar vs chain total. |
| 4 | **Accounting amortizes within a channel, not across hops.** | `batch-settlement` batch claim collapses many requests into one on-chain tx. | Cross-hop you still have N independent channels/settlements/receipts. Receipt + channel count per goal. |
| 5 | **The quote isn't locked across the round-trip.** | `upto` lets the client authorize a max so a price move doesn't reject the payment. | Surge between a buyer's 402 and its paid retry → `exact` rejects the underpayment (§0.3). Show the failed hop + "upto would absorb this, but only for one hop." |
| 6 | **Latency stacks per hop regardless of scheme.** | Channels cut on-chain *frequency*, not the serial request chain. | 1-hop vs 3-hop wall-clock; latency histogram by depth. |
| 7 | **Capital lockup compounds per hop** *(v2-specific, new).* | `batch-settlement` requires an upfront on-chain **deposit** (e.g. `depositMultiplier: 5`). | A recursive market locks idle USDC in escrow at *every* hop. Show total deposited vs total actually spent (Appendix C track). |
| 8 | **Verify ≠ settle ⇒ seller's wasted work.** | — | This middleware *buffers* the handler's output and only releases it **after** settlement succeeds (on settle-failure the buyer gets an error, **not** the goods — §0.1). So the exposure is seller-side: the agent did the (possibly paid-downstream) work, then settlement of the *incoming* payment fails (e.g. payer moved funds between verify and settle) — wasted compute, and in the chain it may have already paid its own downstream. Force a settle-failure (or note the window) and show the agent that worked-but-wasn't-paid. |

> The fail-mode toggle (`ok` / `degraded` / `error`) replaces the old "kill the process" trick: it's
> the only way to produce genuine stranded spend given settle-on-`2xx` (§0.1), and `error` vs
> `degraded` cleanly contrasts "buyer protected (cancel)" with "money stranded (settled then wasted)."

---

## 12. Safety + cost rails (do these first)

- **Testnet only** while building. A recursive loop with a bug fans out into real settlements fast —
  stay on Base Sepolia until the cascade and budget logic are proven.
- **Per-payment ceiling = the selector** (§6): the `x402Client` selector rejects any 402 option above
  the cap (v2 has no `maxValue` arg). Keep it low (e.g. `50_000n` = $0.05).
- **Per-goal ceiling = `BudgetGuard`, keyed by `goalId`** (not a singleton — concurrent goals would
  clobber each other's `spent`). Remember it only enforces the hop the orchestrator pays (§7).
- **Max-hop-depth guard:** propagate an `X-Hop-Depth` header, increment on each downstream call, and
  have every seller reject (`400`) past a small N. A mis-wired agent then can't recurse forever — and
  the rejection is itself a clean demo artifact.
- **Loop/cycle guard:** if agents ever pick *which* downstream agent to hire, carry the visited set in
  a header and reject A→B→A, or you get an infinite paid loop.
- **Facilitator allowance:** the CDP facilitator has a free monthly tx allowance; a recursive market
  burns it — a nice "we hit the ceiling" data point, but budget for it.
- **batch-settlement deposits (Appendix C):** that scheme makes an on-chain deposit — needs ETH for
  gas and locks USDC. Use tiny deposits on testnet.
- Keys in `.env`, gitignored. Commit only `.env.example`. Never log a private key.

---

## 13. Build order for Claude Code (suggested prompts)

0. **Spike first (do this before anything else — §0).** *"Make a two-file v2 spike: a `@x402/express`
   seller on `:5001` with one `exact`-scheme 402 route, and a buyer using `x402Client` +
   `ExactEvmScheme` + `wrapFetchWithPayment`. (a) Confirm a real Base Sepolia v2 settlement end-to-end
   and print the decoded settle response via `new x402HTTPClient(client).getPaymentSettleResponse(...)`.
   (b) Make the seller's handler return `500` and confirm whether the on-chain USDC balance moved —
   does this build settle or cancel on a `>=400` handler response (§0.1)? (c) Print `Object.keys()` of
   `@x402/express`, `@x402/fetch`, `@x402/evm/exact/server`, `@x402/evm/exact/client`. (d) Confirm the
   configured `FACILITATOR_URL` speaks v2 on Base Sepolia. Report all four findings."*
1. *"Scaffold §2; install §4 deps (ESM + tsx); add `.env.example`, `.gitignore`, and an ESM tsconfig."*
2. *"Implement `shared/`: types (events carry `goalId`), `report.ts` (POST to `ORCH_INGEST_URL`),
   `pricing.ts`, `dynamicPaywall.ts`, `buyer.ts` with the spend-cap selector. Adapt every import to
   the symbols the spike actually found."*
3. *"Implement the terminal `verify` seller: dynamic paywall, `ok/degraded/error` mode toggle, `/surge`,
   and a curl test that 402s without payment and 200s+settles with it."*
4. *"Implement the recursive `fetch` and `search` agents (seller+buyer): propagate `X-Goal-Id` and
   `X-Hop-Depth`, read settle receipts, echo `_priceUsd`, and emit `stranded` per §6."*
5. *"Implement the orchestrator: single `emit()` funnel (event-log append + `ledger.apply` + WebSocket
   send) so hop 1 is counted too; replay the log on each WS connection and expose `/state`; `Ledger`
   (per-goal spend+margin), per-`goalId` `BudgetGuard` (cap $0.03), `budget_exceeded` detection from
   the reconstructed chain total, and `/goal`. Make `reportEvent` await its POST so totals are
   complete."*
6. *"Build the vanilla dashboard: tree, ledger, stranded counter, latency histogram, per-seller surge
   buttons, fail-mode toggle, and the 'what broke and why' panel from §11. On load, replay history
   from the WS connection (or pull `/state`) so a refresh isn't blank."*
7. *"Run the chain end-to-end. Confirm the budget bar shows hop-1 cap respected but chain total
   ($0.035) over the $0.03 goal cap. In `degraded` mode confirm the stranded counter reflects a REAL
   settled tx (paste the hash); in `error` mode confirm no money moved. Surge a hop past the cap and
   capture the selector rejection."*
8. *"(Stretch, Appendix C) Swap the orchestrator↔search hop to `batch-settlement`; show the deposit tx
   and the capital-lockup panel (deposited vs spent). For the refund row, demo a `batch-settlement`
   cooperative refund or an `exact` business-logic reverse transfer — NOT auth-capture (client-only).
   Show it can't cascade up the chain."*
9. *"(Stretch, Appendix D) Replace the hardwired downstream URLs with CDP Bazaar discovery
   (`/v2/x402/discovery/*` or `extensions.discovery.listResources()`) so buyers find the next hop at
   runtime. Confirm the testnet resources actually appear in the catalog first."*
10. *"Write the README: setup, faucet links, run order, the spike's settle-on-error finding, and the
    §11 composition-gap table with real numbers + tx hashes."*

---

## 14. Why this lands with the x402 team specifically

Their vision is an economy run by software — "autonomous, intelligent, and always on," value moving
as freely as information. Composition is the unspoken promise of putting payments *in HTTP*: if
requests compose, payments should too. A recursive market that **works** proves the promise. And
because it's built on **v2**, the failure modes it surfaces aren't strawmen — the team already shipped
payment channels (`batch-settlement`), cooperative refunds, and authorized-max (`upto`) payments. The
demo's contribution is precisely that **those mechanisms each solve one hop and none of them
compose**: a channel is point-to-point, a refund is per-payment/per-channel, an `upto` max bounds a
single seller, a deposit locks capital at every hop, and even Bazaar discovery is per-resource rather
than per-path. That's the live frontier of their own roadmap, demonstrated with on-chain receipts and
a reproducible harness. That's the screenshot.

---

## Appendix A — funding & faucets

- **Base Sepolia testnet USDC:** Circle's faucet (`faucet.circle.com`, select Base Sepolia). Fund
  each agent wallet with enough to pay one hop per goal a few dozen times. The orchestrator needs the
  most.
- **ETH for gas:** generally **not** needed for the `exact` scheme (facilitator sponsors gas via
  ERC-3009). The `batch-settlement` stretch (Appendix C) *does* need ETH for the deposit tx — use a
  Base Sepolia ETH faucet for those wallets only. Confirm gas responsibility for your facilitator.

## Appendix B — if you must fall back to v1 (`x402-express` / `x402-fetch`)

Only if v2 doesn't install cleanly. Seller: `import { paymentMiddleware } from "x402-express"` with a
flat route map (`{ "GET /x": { price, network: "base-sepolia", config: { description } } }`) and
`{ url: FACILITATOR_URL }`. Buyer: `createSigner("base-sepolia", key)` then
`wrapFetchWithPayment(fetch, signer, maxValueAtomic)` (v1 *does* take a positional `maxValue`), and
read receipts with `decodeXPaymentResponse(res.headers.get("x-payment-response"))`. Network is the
string `"base-sepolia"`, not the CAIP id. v1 has none of the `batch-settlement`/`auth-capture`/`upto`
schemes, so the §11 framing reverts to plain "x402 lacks sessions/refunds/spend-flexibility." Re-run
the step-0 spike against v1 — its settle-on-error behavior has varied across releases.

## Appendix C — stretch: advanced schemes (`batch-settlement`, `auth-capture`) and the composition gap

To make §11 rows 1, 2, 4, and 7 concrete instead of narrated, swap one hop to an advanced scheme:

- **`batch-settlement` on orchestrator↔search.** Client:
  ```ts
  import { toClientEvmSigner } from "@x402/evm";
  import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
  import { createPublicClient, http } from "viem";
  import { baseSepolia } from "viem/chains";
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.EVM_RPC_URL) });
  const signer = toClientEvmSigner(privateKeyToAccount(key), publicClient);
  const scheme = new BatchSettlementEvmScheme(signer, { depositPolicy: { depositMultiplier: 5 } });
  client.register("eip155:*", scheme);
  ```
  Server side registers the matching `@x402/evm/batch-settlement/server` scheme; the facilitator needs
  `@x402/evm/batch-settlement/facilitator`. Surface the **deposit tx** and a "deposited vs spent"
  panel (row 7). Then point out: search↔fetch needs its *own* channel — the orchestrator's channel
  doesn't extend down (row 1).
- **Refund story (row 2) — use what's actually live.** Lead with `batch-settlement`'s **cooperative
  refunds** (defined in the scheme, intermediary pays the fee) and/or an `exact` business-logic
  reverse transfer; demonstrate that either is per-payment/per-channel and cannot cascade up the
  chain. **Do not** build the demo on `auth-capture` (`@x402/evm/auth-capture/client`): it ships the
  **client only** (server + facilitator "follow in a later change"), so an end-to-end refund through
  it likely isn't runnable today. You can still *mention* its escrow capture/void/refund model and
  per-payment `captureDeadline`/`refundDeadline` as the roadmap direction — and that its client-only
  status is itself a reportable data point — but keep it out of the runnable path.

Keep the baseline demo on `exact` for all hops; treat this appendix as the "now watch the
sophisticated mechanisms *also* fail to compose" encore.

## Appendix D — stretch: real service discovery via CDP Bazaar (makes "machine-discovered" literal)

The baseline hardwires downstream URLs (§5/§6), so it does **counterparty** discovery in name only.
To make it real, have each buyer look up the next hop through CDP's **Bazaar** discovery layer
instead of a constant:

- **Sellers self-register by getting paid:** the CDP facilitator auto-catalogs an endpoint the first
  time it settles a payment for it (no separate registration). Provide good `description`/`mimeType`
  in the route config so the listing is useful.
- **Buyers discover before paying:** query the catalog (`GET /v2/x402/discovery/resources`,
  paginated) or semantic search (`GET /v2/x402/discovery/search?query=…`), or in the TS SDK build the
  facilitator client `withBazaar` and call `facilitatorClient.extensions.discovery.listResources()`.
  Inspect each candidate's advertised price/schema, pick one (cheapest, or best semantic match), then
  pay it with the same `wrapFetchWithPayment` flow.
- **Confirm before relying on it:** check the discovery endpoints actually return your testnet
  resources in the step-0 spike (catalog freshness/eventual consistency varies), and that the
  facilitator you use is the one indexing them (this is a CDP-facilitator feature).

This also adds a genuine composition observation worth reporting: discovery returns **per-resource**
listings with **per-call** prices — there's still no notion of discovering a *priced multi-hop path*
("who can answer this end-to-end, and for how much?"). The orchestrator must discover and price each
hop independently. That's the discovery-layer mirror of the §11 composition gap.

