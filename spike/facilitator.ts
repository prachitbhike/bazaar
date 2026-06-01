/**
 * Facilitator factory.
 *
 * SPIKE FINDING (d) — RESOLVED: the CDP v2 facilitator needs auth headers
 * (FacilitatorConfig.createAuthHeaders), which the @x402/* packages don't ship. The official
 * bridge is `@coinbase/x402`: `createFacilitatorConfig(id, secret)` returns a full FacilitatorConfig
 * with both the CDP url (api.cdp.coinbase.com) AND the JWT createAuthHeaders impl. It defaults to the
 * env vars CDP_API_KEY_ID / CDP_API_KEY_SECRET — so for the CDP path you don't even need FACILITATOR_URL.
 *
 * A no-auth facilitator (community / self-hosted v2 on Base Sepolia) is still supported via
 * FACILITATOR_URL with no CDP creds.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";

export function makeFacilitator(): HTTPFacilitatorClient {
  const cdpId = process.env.CDP_API_KEY_ID;
  const cdpSecret = process.env.CDP_API_KEY_SECRET;
  const url = process.env.FACILITATOR_URL;
  const looksLikeCdp = (url?.includes("cdp.coinbase.com") ?? false) || Boolean(cdpId);

  if (looksLikeCdp) {
    if (!cdpId || !cdpSecret) {
      throw new Error(
        "CDP facilitator requires CDP_API_KEY_ID and CDP_API_KEY_SECRET in .env " +
          "(get them from the CDP portal).",
      );
    }
    // @coinbase/x402 supplies both the CDP v2 url and the createAuthHeaders (JWT) implementation.
    return new HTTPFacilitatorClient(createFacilitatorConfig(cdpId, cdpSecret));
  }

  if (!url) {
    throw new Error(
      "No facilitator configured. Set CDP_API_KEY_ID/SECRET for CDP, or FACILITATOR_URL " +
        "for a no-auth v2 facilitator.",
    );
  }
  return new HTTPFacilitatorClient({ url });
}
