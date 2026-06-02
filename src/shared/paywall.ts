/**
 * makePaywall() — a 402-gated @x402/express middleware with PER-REQUEST dynamic pricing.
 *
 * Supersedes the plan's §5 `dynamicPaywall.ts` middleware-rebuild shim. The step-0 spike confirmed
 * that v2.14 types `PaymentOption.price` as `Price | DynamicPrice` where `DynamicPrice = (ctx) =>
 * Price`, so the 402 amount can be a callback evaluated fresh on every request. We therefore build
 * the middleware ONCE (no per-request rebuild) and pass `price: () => priceNow()`; the next 402
 * reflects the current load (and any /surge bump) automatically.
 *
 * The resource server (facilitator + exact scheme) is price-independent, so it's built once here.
 */
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { makeFacilitator } from "./facilitator";

export function makePaywall(opts: {
  routeKey: string; // e.g. "GET /verify"
  payTo: `0x${string}`;
  network: `${string}:${string}`; // "eip155:84532"
  priceNow: () => `$${string}`; // native DynamicPrice — evaluated per request
  description: string;
}) {
  const resourceServer = new x402ResourceServer(makeFacilitator()).register(
    opts.network,
    new ExactEvmScheme(),
  );

  return paymentMiddleware(
    {
      [opts.routeKey]: {
        accepts: [
          { scheme: "exact", payTo: opts.payTo, price: () => opts.priceNow(), network: opts.network },
        ],
        description: opts.description,
        mimeType: "application/json",
      },
    },
    resourceServer,
  );
}
