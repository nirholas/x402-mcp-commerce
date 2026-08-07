/**
 * Agent wallet + spending caps (the x402-agent-wallet pattern).
 *
 * The wallet that pays upstream lives entirely in env — nothing is written to
 * disk and no key ever appears in a tool result. Caps are enforced *before* a
 * payment is signed, so a runaway loop stops at the ledger rather than at the
 * chain:
 *
 *   MAX_PER_CALL_USD   most this agent will pay for any single tool call
 *   MAX_SESSION_USD    total this process may spend before it refuses
 *   MAX_CALLS          total paid calls this process may make
 *   ALLOWED_TOOLS      comma-separated allowlist; empty means "all registered"
 *
 * Every settled payment is appended to an in-memory ledger, readable through the
 * `spending_report` tool and the inspector's `GET /ledger`.
 */
import { privateKeyToAccount } from "viem/accounts";

export interface LedgerEntry {
  at: string;
  tool: string;
  upstream: string;
  resource: string;
  rail: "evm" | "solana";
  network: string;
  amountUsd: number;
  transaction: string | null;
  payer: string | null;
}

export class CapExceeded extends Error {
  constructor(
    public code: "PER_CALL_CAP" | "SESSION_CAP" | "CALL_CAP" | "TOOL_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
  }
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const caps = {
  perCallUsd: num(process.env.MAX_PER_CALL_USD, 0.05),
  sessionUsd: num(process.env.MAX_SESSION_USD, 1),
  calls: num(process.env.MAX_CALLS, 200),
  allowedTools: (process.env.ALLOWED_TOOLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

const ledger: LedgerEntry[] = [];
let spentUsd = 0;

export function evmAccount() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
  return privateKeyToAccount(pk as `0x${string}`);
}

/** Present only when a Solana key is configured; the Solana rail needs it to sign. */
export function solanaConfigured(): boolean {
  return Boolean(process.env.SOLANA_PRIVATE_KEY);
}

/** Which rails this process can actually pay on, given the keys it holds. */
export function availableRails(): Array<"evm" | "solana"> {
  const rails: Array<"evm" | "solana"> = [];
  if (evmAccount()) rails.push("evm");
  if (solanaConfigured()) rails.push("solana");
  return rails;
}

/** Parse a price string like "$0.01" into a number. Non-numeric prices ("per item") are unknown. */
export function priceUsd(price: string): number | null {
  const m = /\$([0-9]*\.?[0-9]+)/.exec(price);
  return m ? Number(m[1]) : null;
}

/**
 * Called before signing. `amountUsd` comes from the upstream 402 when we have
 * it, or the registry's price hint otherwise; `null` means "unknown", which is
 * checked against the per-call cap as if it were the full cap.
 */
export function assertWithinCaps(tool: string, amountUsd: number | null): void {
  if (caps.allowedTools.length && !caps.allowedTools.includes(tool)) {
    throw new CapExceeded("TOOL_NOT_ALLOWED", `tool "${tool}" is not in ALLOWED_TOOLS`);
  }
  if (ledger.length >= caps.calls) {
    throw new CapExceeded("CALL_CAP", `paid-call cap reached (MAX_CALLS=${caps.calls})`);
  }
  const amount = amountUsd ?? caps.perCallUsd;
  if (amount > caps.perCallUsd) {
    throw new CapExceeded(
      "PER_CALL_CAP",
      `this call costs $${amount} which exceeds MAX_PER_CALL_USD=$${caps.perCallUsd}`,
    );
  }
  if (spentUsd + amount > caps.sessionUsd) {
    throw new CapExceeded(
      "SESSION_CAP",
      `spending $${amount} would exceed MAX_SESSION_USD=$${caps.sessionUsd} (already spent $${spentUsd.toFixed(6)})`,
    );
  }
}

export function record(entry: LedgerEntry): void {
  ledger.push(entry);
  spentUsd += entry.amountUsd;
}

export function report() {
  return {
    caps: {
      maxPerCallUsd: caps.perCallUsd,
      maxSessionUsd: caps.sessionUsd,
      maxCalls: caps.calls,
      allowedTools: caps.allowedTools.length ? caps.allowedTools : "all registered tools",
    },
    spent: {
      usd: Number(spentUsd.toFixed(6)),
      calls: ledger.length,
      remainingUsd: Number(Math.max(0, caps.sessionUsd - spentUsd).toFixed(6)),
      remainingCalls: Math.max(0, caps.calls - ledger.length),
    },
    wallets: {
      evm: evmAccount()?.address ?? null,
      solana: solanaConfigured() ? "configured (address withheld)" : null,
    },
    rails: availableRails(),
    ledger,
  };
}
