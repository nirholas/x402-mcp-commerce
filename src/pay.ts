/**
 * Calling an upstream x402 route and paying for it — with the agent choosing
 * the payment rail.
 *
 * Suite services answer an unpaid request with a dual-rail 402: `accepts` holds
 * one entry for USDC on Base (EVM, EIP-3009) and one for USDC on Solana (SPL
 * transferChecked). This module decides which entry to sign:
 *
 *   rail = "evm"     always take the EVM entry; fail if the upstream has none
 *   rail = "solana"  always take the Solana entry; fail if the upstream has none
 *   rail = "auto"    prefer a rail this process actually holds a key for,
 *                    EVM first (that is what x402-fetch can sign today)
 *
 * The rail comes from `X402_RAIL` (server-wide), the registry's `defaults.rail`,
 * the tool's own `rail` field, `X402_RAIL_<TOOL>`, or a `rail` argument on the
 * individual tool call — later wins. So an agent can run mostly on Solana and
 * still route one particular merchant over Base.
 *
 * Every call returns the upstream artifact *and* the decoded payment receipt,
 * so an MCP tool result is self-describing: what you bought and what it cost.
 */
import { selectPaymentRequirements } from "x402/client";
import type { PaymentRequirements } from "x402/types";
import { wrapFetchWithPayment } from "x402-fetch";
import { buildUrl, type Rail, type ToolDef } from "./config.js";
import { buildSolanaPayment } from "./solana.js";
import { CapExceeded, assertWithinCaps, availableRails, evmAccount, priceUsd, record } from "./wallet.js";

export interface CallResult {
  tool: string;
  upstream: string;
  resource: string;
  paid: boolean;
  /** Requested rail, and the one actually used. */
  rail: { requested: Rail; used: "evm" | "solana" | null };
  /** The upstream response body — the purchased artifact. */
  artifact: unknown;
  /** Decoded X-PAYMENT-RESPONSE, when the call was paid. */
  receipt: Record<string, unknown> | null;
  /** What the upstream 402 asked for, so the agent can see the price it paid. */
  price: { usd: number | null; atomic: string | null; asset: string | null } | null;
}

export class UpstreamError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const EVM_NETWORKS = ["base-sepolia", "base"] as const;

function isSolana(network: string): boolean {
  return network.startsWith("solana");
}

/** Resolve the rail for this call: explicit argument beats tool config beats default. */
export function resolveRail(tool: ToolDef, override?: unknown): Rail {
  const o = typeof override === "string" ? override : undefined;
  if (o === "evm" || o === "solana" || o === "auto") return o;
  return tool.rail ?? "auto";
}

/** Pick the `accepts` entry matching the chosen rail. Throws when it isn't offered. */
function pickRequirement(accepts: PaymentRequirements[], rail: Rail, tool: string): PaymentRequirements {
  const evm = accepts.filter((a) => (EVM_NETWORKS as readonly string[]).includes(a.network));
  const svm = accepts.filter((a) => isSolana(a.network));

  if (rail === "evm") {
    if (!evm.length) {
      throw new UpstreamError(502, "RAIL_UNAVAILABLE", `${tool}: upstream does not accept an EVM rail (offered: ${accepts.map((a) => a.network).join(", ")})`);
    }
    return selectPaymentRequirements(evm, undefined, "exact");
  }
  if (rail === "solana") {
    if (!svm.length) {
      throw new UpstreamError(502, "RAIL_UNAVAILABLE", `${tool}: upstream does not accept a Solana rail (offered: ${accepts.map((a) => a.network).join(", ")})`);
    }
    return selectPaymentRequirements(svm, undefined, "exact");
  }

  // auto: take a rail we hold a key for, EVM first.
  const held = availableRails();
  if (held.includes("evm") && evm.length) return selectPaymentRequirements(evm, undefined, "exact");
  if (held.includes("solana") && svm.length) return selectPaymentRequirements(svm, undefined, "exact");
  throw new UpstreamError(
    402,
    "NO_USABLE_RAIL",
    `${tool}: upstream offers ${accepts.map((a) => a.network).join(", ")} but this agent holds keys for ${held.join(", ") || "no rail"}`,
  );
}

function decodeReceipt(res: Response): Record<string, unknown> | null {
  const h = res.headers.get("x-payment-response");
  if (!h) return null;
  try {
    return JSON.parse(Buffer.from(h, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { raw: h };
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Execute one tool call against its upstream.
 *
 * Free routes are fetched directly. Paid routes are probed first (an unpaid
 * request), so the real price from the upstream's 402 — not the registry's
 * hint — is what the spending caps are checked against. Only then is the
 * payment signed and the request retried.
 */
export async function callTool(tool: ToolDef, args: Record<string, unknown>, railOverride?: unknown): Promise<CallResult> {
  const rail = resolveRail(tool, railOverride);
  const { url, body } = buildUrl(tool, args);
  const timeoutMs = Number(process.env.X402_TIMEOUT_MS || 20_000);

  const init: RequestInit = {
    method: tool.method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  };

  // 1. Unpaid probe. A free route answers 200 here and we are done.
  let probe: Response;
  try {
    probe = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new UpstreamError(502, "UPSTREAM_UNREACHABLE", `${tool.name}: cannot reach ${tool.baseUrl} — ${(e as Error).message}`);
  }

  if (probe.status !== 402) {
    const artifact = await readBody(probe);
    if (!probe.ok) {
      throw new UpstreamError(probe.status, "UPSTREAM_ERROR", `${tool.name}: upstream returned ${probe.status} — ${JSON.stringify(artifact).slice(0, 300)}`);
    }
    return {
      tool: tool.name,
      upstream: tool.upstream,
      resource: url,
      paid: false,
      rail: { requested: rail, used: null },
      artifact,
      receipt: null,
      price: null,
    };
  }

  // 2. Paid. Read the challenge, pick the rail, check the caps against the real price.
  const challenge = (await readBody(probe)) as { accepts?: PaymentRequirements[] };
  const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
  if (!accepts.length) {
    throw new UpstreamError(502, "MALFORMED_CHALLENGE", `${tool.name}: upstream returned 402 with no accepts[]`);
  }

  const requirement = pickRequirement(accepts, rail, tool.name);
  const used: "evm" | "solana" = isSolana(requirement.network) ? "solana" : "evm";
  const decimals = Number((requirement.extra as { decimals?: number } | undefined)?.decimals ?? 6);
  const amountUsd = Number(requirement.maxAmountRequired) / 10 ** decimals;

  assertWithinCaps(tool.name, Number.isFinite(amountUsd) ? amountUsd : priceUsd(tool.price));

  // 3. Sign the payment for the chosen rail and retry.
  let res: Response;
  let payerAddress: string | null = null;

  if (used === "solana") {
    // SPL transferChecked: build it, sign it with the agent's Solana keypair,
    // and send the envelope by hand. x402-fetch only signs the EVM scheme.
    let header: string;
    try {
      const built = await buildSolanaPayment(requirement, url);
      header = built.header;
      payerAddress = built.payer;
    } catch (e) {
      throw new UpstreamError(
        501,
        "SOLANA_PAYMENT_FAILED",
        `${tool.name}: could not build the Solana payment — ${(e as Error).message}. ` +
          `Set X402_RAIL_${tool.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}=evm to pay this tool on Base instead.`,
      );
    }
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), "X-PAYMENT": header },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new UpstreamError(502, "PAYMENT_FAILED", `${tool.name}: paying ${url} on Solana failed — ${(e as Error).message}`);
    }
  } else {
    const account = evmAccount();
    if (!account) {
      throw new UpstreamError(401, "NO_WALLET", `${tool.name}: PRIVATE_KEY is not set, so nothing can be paid for`);
    }
    payerAddress = account.address;
    // Pin the selector to the exact entry we chose, so x402-fetch cannot
    // silently pick a different rail than the one the agent asked for.
    const payFetch = wrapFetchWithPayment(fetch, account, undefined, () => requirement);
    try {
      res = await payFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new UpstreamError(502, "PAYMENT_FAILED", `${tool.name}: paying ${url} failed — ${(e as Error).message}`);
    }
  }

  const artifact = await readBody(res);
  if (!res.ok) {
    throw new UpstreamError(res.status, "UPSTREAM_ERROR", `${tool.name}: upstream returned ${res.status} after payment — ${JSON.stringify(artifact).slice(0, 300)}`);
  }

  const receipt = decodeReceipt(res);
  record({
    at: new Date().toISOString(),
    tool: tool.name,
    upstream: tool.upstream,
    resource: url,
    rail: used,
    network: String(receipt?.network ?? requirement.network),
    amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
    transaction: (receipt?.transaction as string) ?? null,
    payer: (receipt?.payer as string) ?? payerAddress,
  });

  return {
    tool: tool.name,
    upstream: tool.upstream,
    resource: url,
    paid: true,
    rail: { requested: rail, used },
    artifact,
    receipt,
    price: {
      usd: Number.isFinite(amountUsd) ? Number(amountUsd.toFixed(6)) : null,
      atomic: requirement.maxAmountRequired,
      asset: requirement.asset,
    },
  };
}

export { CapExceeded };
