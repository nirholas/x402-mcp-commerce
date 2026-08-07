/**
 * Signed capability attestations.
 *
 * An MCP server is a *buyer*, so it has almost nothing to sell — with one
 * exception. Anyone downstream of this agent (a coordinator routing work to it,
 * a human approving a purchase, an auditor reconciling a bill) needs to know
 * what it is able to spend and where, and they should not have to take the
 * agent's own word for it.
 *
 * `GET /attest` sells exactly that: a timestamped, HMAC-signed snapshot of the
 * tool registry, per-tool prices and rails, the spending caps, and the budget
 * left. The artifact is returned in the same response — no callback, nothing
 * pending — and can be verified offline with `SIGNING_SECRET` or through the
 * free `POST /verify`.
 */
import { loadRegistry } from "./config.js";
import { signArtifact, type SignedArtifact } from "./sign.js";
import { availableRails, report } from "./wallet.js";

export interface Attestation {
  attestationId: string;
  issuedAt: string;
  expiresAt: string;
  server: { name: string; version: string };
  rails: { default: string; available: string[]; note: string };
  caps: ReturnType<typeof report>["caps"];
  budget: ReturnType<typeof report>["spent"];
  tools: Array<{
    name: string;
    description: string;
    upstream: string;
    baseUrl: string;
    route: string;
    price: string;
    rail: string;
    affordable: boolean;
  }>;
  [key: string]: unknown;
}

const TTL_SECONDS = Number(process.env.ATTESTATION_TTL_SECONDS || 300);

export function attest(): SignedArtifact<Attestation> {
  const registry = loadRegistry();
  const state = report();
  const now = new Date();

  const tools = registry.tools.map((t) => {
    const price = /\$([0-9]*\.?[0-9]+)/.exec(t.price);
    const usd = price ? Number(price[1]) : null;
    return {
      name: t.name,
      description: t.description,
      upstream: t.upstream,
      baseUrl: t.baseUrl,
      route: `${t.method} ${t.path}`,
      price: t.price,
      rail: t.rail ?? registry.defaults.rail,
      // Whether this agent could pay for the tool right now under its own caps.
      affordable:
        usd === null
          ? state.spent.remainingUsd > 0
          : usd <= state.caps.maxPerCallUsd && usd <= state.spent.remainingUsd,
    };
  });

  return signArtifact<Attestation>({
    attestationId: `att_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_SECONDS * 1000).toISOString(),
    server: { name: "x402-mcp-commerce", version: "0.1.0" },
    rails: {
      default: registry.defaults.rail,
      available: availableRails(),
      note: "Every upstream offers USDC on Base and USDC on Solana; this agent picks per call.",
    },
    caps: state.caps,
    budget: state.spent,
    tools,
  });
}
