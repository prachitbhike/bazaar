/**
 * X-Hop-Depth recursion guard (plan §12).
 *
 * A recursive market with a wiring bug fans out into REAL settlements fast. Each downstream call
 * carries an X-Hop-Depth header, incremented per hop; every seller rejects (400) anything past a
 * small ceiling BEFORE the payment dance, so a mis-wired loop can't recurse forever — and the
 * rejection is itself a clean demo artifact.
 *
 * Legit depths in the baseline topology: orchestrator->search = 1, search->fetch = 2,
 * fetch->verify = 3. Anything above MAX_HOP_DEPTH means a loop/bug.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, RequestHandler } from "express";

export const HOP_DEPTH_HEADER = "X-Hop-Depth";
export const GOAL_ID_HEADER = "X-Goal-Id";
export const MAX_HOP_DEPTH = 4; // deepest legit hop is 3 (verify); >4 is a recursion bug

export function incomingDepth(req: Request): number {
  const raw = req.header(HOP_DEPTH_HEADER);
  if (raw === undefined || raw.trim() === "") return 0; // header absent/blank => legit entrypoint, depth 0
  // Header present but unparseable (non-numeric / NaN / Infinity / Express-joined "1,1"): do NOT
  // silently reset to 0 — that bypasses the guard. Return a value that trips hopDepthGuard.
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : MAX_HOP_DEPTH + 1;
}

export function goalIdOf(req: Request): string {
  return req.header(GOAL_ID_HEADER) ?? "?";
}

/** Express middleware: 400 a too-deep request before it reaches the paywall (no payment dance). */
export const hopDepthGuard: RequestHandler = (req, res, next) => {
  const depth = incomingDepth(req);
  if (depth > MAX_HOP_DEPTH) {
    res.status(400).json({ error: `hop depth ${depth} exceeds max ${MAX_HOP_DEPTH} — recursion guard` });
    return;
  }
  next();
};

/**
 * Per-request hop context (plan §12, finding #6). Carries the goalId and INBOUND depth so the
 * buyer's pay() wrapper (shared/buyer.ts) can stamp the outbound X-Goal-Id / X-Hop-Depth headers on
 * EVERY downstream call automatically — no agent can forget them, and they're guaranteed present on
 * the x402 wrapper's automatic 402->paid retry. It also exposes a `signedAtomic` slot the buyer's
 * selector fills with the exact atomic amount it signed, so the caller can ledger the authoritative
 * on-chain charge instead of a recomputed echo (finding #4).
 *
 * AsyncLocalStorage gives each in-flight request its own store, so concurrent goals never race on
 * goalId, depth, or signedAtomic (§12).
 */
export interface HopContext {
  goalId: string;
  /** Depth of the INBOUND hop into this process; the root orchestrator has no inbound hop, so 0. */
  depth: number;
  /** Atomic amount the buyer's selector signed for THIS request's single outbound hop (USDC units). */
  signedAtomic?: bigint;
}

const hopStorage = new AsyncLocalStorage<HopContext>();

export function runInHopContext<T>(ctx: HopContext, fn: () => T): T {
  return hopStorage.run(ctx, fn);
}

export function currentHop(): HopContext | undefined {
  return hopStorage.getStore();
}

/** Express middleware: seed the hop context from the inbound request for the whole handler chain. */
export const hopContextMiddleware: RequestHandler = (req, _res, next) => {
  runInHopContext({ goalId: goalIdOf(req), depth: incomingDepth(req) }, () => next());
};
