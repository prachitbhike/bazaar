/**
 * makeRecursiveAgent() — the shared seller+buyer agent used by both `search` and `fetch` (plan §6).
 *
 * search and fetch are the same animal: a paywalled seller on its own route that, to fulfil a
 * request, becomes the BUYER of exactly one downstream hop. The flow is identical for both —
 * work_done -> hop_start -> pay(downstream) -> settledAmountUsd -> hop_settled -> (optional business
 * rule) -> resell, with hop_failed cancelling the upstream payment on any error. Every response
 * (2xx, strand, or cancel) carries the in-band `_settlement` summary, folding this hop's own
 * settled/stranded spend into whatever the downstream subtree reported (shared/buyer.ts
 * composeSettlement) so the orchestrator's headline totals stay authoritative (§7, finding #2/#4).
 *
 * Only the labels, ports, URLs, prices, and the success-body shape differ; those are the options
 * below. The one genuine behavioural fork is fetch's stranded-spend rule (§6/§11): it has already
 * SETTLED with verify (real tx) but a low-confidence result can't be resold, so it must return 5xx
 * and eat the loss. That rule is the optional `onResult` hook — a PURE function of the downstream
 * body that returns a strand decision; the factory owns all the I/O (event reporting + the 502
 * response) and folds the stranded amount into `_settlement`.
 */
import express from "express";
import { makePaywall } from "./paywall";
import { makeBuyer, readBody, readSettlement, composeSettlement } from "./buyer";
import { priceFor, bumpLoad } from "./pricing";
import { reportEvent } from "./report";
import { hopDepthGuard, hopContextMiddleware, goalIdOf } from "./hops";
import type { AgentName, SettlementSummary } from "./types";

type Seller = Exclude<AgentName, "orchestrator">;

/** Returned by an onResult hook to STRAND the (already-settled) payment and fail upstream. */
export interface StrandDecision {
  reason: string; // the stranded event's reason
  errorBody: Record<string, unknown>; // the 502 JSON body (the factory appends `_settlement`)
}

export interface RecursiveAgentOpts {
  /** Event identity: work_done.agent, hop_*.from, stranded.agent. */
  self: AgentName;
  /** The downstream agent this one pays — the `to` of its hop. */
  downstream: AgentName;
  /** Paywall route key, e.g. "GET /search" (the path is also used to register the express route). */
  routeKey: string;
  /** Listen port. */
  port: number;
  /** This seller's payout address. */
  payTo: `0x${string}`;
  /** This buyer's signing key. */
  privateKey: `0x${string}`;
  /** CAIP-2 network id, e.g. "eip155:84532". */
  network: `${string}:${string}`;
  /** URL of the downstream resource this agent buys from. */
  downstreamUrl: string;
  /** Pricing/surge key for priceFor()/bumpLoad() and the /surge route. */
  priceKey: Seller;
  /** 402 resource description. */
  paywallDescription: string;
  /** `work_done` detail string. */
  workDetail: string;
  /** Build the success body from the downstream body (factory appends `_settlement`). */
  buildResult: (downstreamBody: unknown) => Record<string, unknown>;
  /** `{ error }` string returned (502) when the downstream hop fails. */
  downstreamFailMsg: string;
  /** Optional post-settlement rule: return a StrandDecision to strand + fail upstream, else null. */
  onResult?: (downstreamBody: unknown) => StrandDecision | null;
}

export function makeRecursiveAgent(opts: RecursiveAgentOpts): void {
  // per-payment cap: 50000 atomic = $0.05 (USDC has 6 decimals). The cap lives in the selector (§6/§12).
  const { pay, readReceipt, settledAmountUsd } = makeBuyer(opts.privateKey, 50_000n);

  const app = express();

  // per-process surge knob — must live on THIS seller's process, not the orchestrator (§0.2/§8).
  app.post("/surge", (_req, res) => {
    bumpLoad(opts.priceKey, 5);
    res.json({ ok: true, price: priceFor(opts.priceKey) });
  });

  app.use(hopContextMiddleware); // seed goalId/depth so the buyer auto-stamps the next hop's headers (#6)
  app.use(hopDepthGuard);
  app.use(
    makePaywall({
      routeKey: opts.routeKey,
      payTo: opts.payTo,
      network: opts.network,
      priceNow: () => priceFor(opts.priceKey),
      description: opts.paywallDescription,
    }),
  );

  const [, routePath] = opts.routeKey.split(" "); // "GET /search" -> "/search"
  app.get(routePath, async (req, res) => {
    const goalId = goalIdOf(req);
    const t0 = Date.now();
    // downstream's in-band summary; read below regardless of status so stranded spend deeper in the
    // chain propagates up even when our own sale cancels (#2). Stays zero if pay() throws first.
    let downstream: SettlementSummary = { settledUsd: 0, strandedUsd: 0, latencyMs: 0 };
    try {
      await reportEvent({ type: "work_done", agent: opts.self, goalId, detail: opts.workDetail });
      await reportEvent({ type: "hop_start", from: opts.self, to: opts.downstream, goalId });

      const hopStart = Date.now();
      const r = await pay(opts.downstreamUrl, { method: "GET" }); // goalId + hop depth auto-stamped by the buyer (#6)
      const hopMs = Date.now() - hopStart;

      const body = await readBody(r); // read once: carries the business fields AND downstream's _settlement
      downstream = readSettlement(body);

      // downstream returned >=400 => the middleware CANCELLED our payment (we paid nothing) but we
      // have nothing to sell. Propagate as our own failure (which cancels OUR upstream payment too).
      if (!r.ok) throw new Error(`${opts.downstream} returned ${r.status}`);

      const paidUsd = settledAmountUsd(r); // authoritative: the amount we signed on-chain, never a $0 echo (#4)
      const receipt = readReceipt(r); // tx hash = on-chain proof of settlement
      await reportEvent({
        type: "hop_settled",
        from: opts.self,
        to: opts.downstream,
        goalId,
        amountUsd: paidUsd,
        tx: receipt?.transaction,
        latencyMs: Math.max(0, hopMs - downstream.latencyMs), // TRUE per-hop latency: our RT minus downstream's own (#5)
      });

      // Optional business rule that creates GENUINE stranded spend (§11): we already SETTLED downstream
      // (real USDC, tx exists), but the result is unusable, so we can't resell -> 5xx -> our upstream
      // payment is CANCELLED. Out of pocket: fold our settled hop in as BOTH settled and stranded.
      const strand = opts.onResult?.(body);
      if (strand) {
        await reportEvent({
          type: "stranded",
          agent: opts.self,
          goalId,
          amountUsd: paidUsd,
          tx: receipt?.transaction,
          reason: strand.reason,
        });
        res.status(502).json({
          ...strand.errorBody,
          _settlement: composeSettlement(paidUsd, paidUsd, downstream, Date.now() - t0),
        });
        return;
      }

      res.json({
        ...opts.buildResult(body),
        // our hop settled; the subtree total is our payment plus everything downstream reported below it.
        _settlement: composeSettlement(paidUsd, 0, downstream, Date.now() - t0),
      });
      bumpLoad(opts.priceKey); // bump AFTER responding -> affects the NEXT goal, not this quote (§0.3)
    } catch (err: any) {
      await reportEvent({ type: "hop_failed", from: opts.self, to: opts.downstream, goalId, reason: String(err?.message ?? err) });
      res.status(502).json({
        error: opts.downstreamFailMsg, // cancels the upstream payment
        // our payment was cancelled (or never signed); only spend BELOW us settled — propagate it (#2).
        _settlement: composeSettlement(0, 0, downstream, Date.now() - t0),
      });
    }
  });

  app.listen(opts.port, () => {
    console.log(`${opts.self} (seller+buyer) on :${opts.port}  payTo=${opts.payTo}  -> ${opts.downstreamUrl}`);
  });
}
