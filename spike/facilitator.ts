/**
 * Spike facilitator factory.
 *
 * SPIKE FINDING (d): the CDP facilitator authenticates via FacilitatorConfig.createAuthHeaders,
 * and the installed @x402/* packages do NOT ship a CDP auth helper. So to settle through CDP you
 * must either:
 *   (1) point FACILITATOR_URL at a no-auth v2 Base Sepolia facilitator (no createAuthHeaders), or
 *   (2) provide CDP credentials and wire createAuthHeaders below (likely via @coinbase/x402).
 *
 * This factory fails LOUD when CDP auth is required but not wired — that's the spike telling you
 * exactly what to provision before the on-chain run.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";

export function makeFacilitator(): HTTPFacilitatorClient {
  const url = process.env.FACILITATOR_URL;
  if (!url) throw new Error("FACILITATOR_URL not set in .env");

  const cdpId = process.env.CDP_API_KEY_ID;
  const cdpSecret = process.env.CDP_API_KEY_SECRET;
  const looksLikeCdp = url.includes("cdp.coinbase.com") || Boolean(cdpId);

  if (looksLikeCdp) {
    if (!cdpId || !cdpSecret) {
      throw new Error(
        "CDP facilitator detected but CDP_API_KEY_ID/SECRET are missing. " +
          "Spike finding (d): wire createAuthHeaders (CDP JWT) or use a no-auth v2 facilitator.",
      );
    }
    return new HTTPFacilitatorClient({
      url,
      // TODO(spike d): generate CDP auth headers (JWT signed with the CDP API key).
      // Confirm the official helper — historically @coinbase/x402 exposed this.
      createAuthHeaders: async () => {
        throw new Error(
          "CDP createAuthHeaders not implemented yet (spike finding d). " +
            "Install/confirm the CDP auth helper before the on-chain run.",
        );
      },
    });
  }

  // No-auth facilitator (community / self-hosted v2 on Base Sepolia).
  return new HTTPFacilitatorClient({ url });
}
