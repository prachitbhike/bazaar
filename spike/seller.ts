/**
 * Step-0 spike — SELLER. One exact-scheme 402 route on :5001.
 *
 * Proves two things the recursive demo depends on:
 *   (a) a real end-to-end v2 settlement on Base Sepolia, and
 *   (b) settle-vs-cancel on a >=400 handler (plan §0.1) — POST /_mode/error then re-buy.
 *
 * SPIKE FINDING (price): v2.14 types PaymentOption.price as `Price | DynamicPrice`, where
 * DynamicPrice = (ctx) => Price. So the 402 amount can be computed PER REQUEST from a price
 * callback — we build the middleware ONCE, no per-request middleware-rebuild shim. This makes
 * the plan's §0.3 / §5 `dynamicPaywall.ts` workaround unnecessary for this build. The /_surge
 * route bumps the live price to demonstrate it.
 *
 * Run: npm run spike:seller   (needs .env: a *_PAY_TO address + facilitator auth)
 */
import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { makeFacilitator } from "./facilitator";

const NETWORK = (process.env.NETWORK ?? "eip155:84532") as `${string}:${string}`;
const PAY_TO = (process.env.SELLER_PAY_TO ?? process.env.VERIFY_PAY_TO) as `0x${string}`;
const PORT = 5001;

if (!PAY_TO || PAY_TO === ("0x" as string)) {
  throw new Error("Set SELLER_PAY_TO (or VERIFY_PAY_TO) in .env to the seller's receiving address");
}

// Fail-mode toggle for the settle-vs-cancel test (§0.1):
//   "ok"    -> 200, payment SHOULD settle (on-chain USDC moves)
//   "error" -> 500, payment SHOULD be cancelled (no USDC moves) — this fact defines stranded spend
let mode: "ok" | "error" = "ok";
let surge = 0;
const priceNow = (): `$${string}` => `$${(0.001 * (1 + surge * 0.5)).toFixed(4)}` as `$${string}`;

const app = express();

const resourceServer = new x402ResourceServer(makeFacilitator()).register(
  NETWORK,
  new ExactEvmScheme(),
);

app.use(
  paymentMiddleware(
    {
      "GET /ping": {
        // price is a CALLBACK, evaluated per request — native dynamic pricing
        accepts: [{ scheme: "exact", payTo: PAY_TO, price: () => priceNow(), network: NETWORK }],
        description: "spike ping",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/ping", (_req, res) => {
  if (mode === "error") {
    return res.status(500).json({ error: "forced 500 — middleware should CANCEL, no settle" });
  }
  res.json({ pong: true, at: new Date().toISOString() });
});

// Control plane — NOT paywalled (only the registered "GET /ping" route is gated).
app.post("/_mode/:m", (req, res) => {
  mode = req.params.m === "error" ? "error" : "ok";
  res.json({ mode });
});
app.post("/_surge", (_req, res) => {
  surge += 1;
  res.json({ surge, price: priceNow() });
});

app.listen(PORT, () => {
  console.log(`spike seller on :${PORT}  network=${NETWORK}  payTo=${PAY_TO}`);
  console.log(`  mode=${mode}  price=${priceNow()}  (POST /_mode/ok|error, POST /_surge)`);
});
