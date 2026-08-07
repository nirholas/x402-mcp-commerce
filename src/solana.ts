/**
 * Paying an upstream x402 route on the SOLANA rail.
 *
 * The EVM rail signs EIP-3009 typed data and needs nothing but a viem account.
 * Solana is different: the payment is an SPL `transferChecked` transaction, so
 * something has to *build* it before the agent can sign. That construction —
 * resolving both token accounts, adding a create-ATA instruction when the payee
 * has none, setting the facilitator's sponsor as fee payer — is exactly what
 * `@three-ws/x402-payment-modal/server` does for browser checkout, so this
 * module reuses it instead of reimplementing the instruction layout:
 *
 *   prepareSolanaCheckout({ accept, buyer, rpcUrl })  → partially signed tx (base64)
 *   <agent signs it with its keypair>
 *   encodeX402Payment({ accept, signedTxBase64, resourceUrl }) → the X-PAYMENT header
 *
 * Because the facilitator's sponsor pays the network fee, the agent's wallet
 * needs USDC and no SOL at all.
 *
 * Note on scope: that package is a *checkout* helper — it builds and wraps what
 * a buyer signs. It is not a verify/settle adapter, and nothing here uses it as
 * one. Verification and settlement are the merchant's job, and every suite
 * service does them through an x402 facilitator (`useFacilitator`).
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import type { PaymentRequirements } from "x402/types";

import { encodeX402Payment, prepareSolanaCheckout } from "@three-ws/x402-payment-modal/server";

/** Load the agent's Solana keypair from env. Accepts base58 or a JSON byte array. */
export function solanaKeypair(): Keypair | null {
  const raw = process.env.SOLANA_PRIVATE_KEY?.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
    }
    return Keypair.fromSecretKey(decodeBase58(raw));
  } catch (e) {
    throw new Error(`SOLANA_PRIVATE_KEY is not a valid base58 or JSON-array secret key: ${(e as Error).message}`);
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 decode — avoids pulling a dependency in for one function. */
function decodeBase58(s: string): Uint8Array {
  let num = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 character "${ch}"`);
    num = num * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * Turn a Solana `accepts` entry into the base64 `X-PAYMENT` header value.
 *
 * `requirement.extra.feePayer` is the facilitator's public sponsor account —
 * suite services always advertise it, and without it the buyer would need SOL.
 */
export async function buildSolanaPayment(
  requirement: PaymentRequirements,
  resourceUrl: string,
): Promise<{ header: string; payer: string }> {
  const keypair = solanaKeypair();
  if (!keypair) {
    throw new Error("SOLANA_PRIVATE_KEY is not set, so the Solana rail cannot be used");
  }

  const extra = (requirement.extra ?? {}) as { feePayer?: string; name?: string; decimals?: number };
  if (!extra.feePayer) {
    throw new Error(
      "the upstream's Solana payment requirement has no extra.feePayer — without a sponsor the agent would need SOL for gas",
    );
  }

  const accept = {
    scheme: "exact" as const,
    network: requirement.network,
    // The modal's helpers read `amount`; x402 SDK clients read `maxAmountRequired`.
    amount: String(requirement.maxAmountRequired),
    asset: requirement.asset,
    payTo: requirement.payTo,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    resource: requirement.resource,
    extra: { ...extra, feePayer: extra.feePayer },
  };

  const rpcUrl = process.env.SOLANA_RPC_URL || undefined;
  const prepared = await prepareSolanaCheckout({
    accept,
    buyer: keypair.publicKey.toBase58(),
    rpcUrl,
    devnetRpcUrl: process.env.SOLANA_DEVNET_RPC_URL || undefined,
  });

  // Sign the prepared transaction. It is partially signed by the sponsor already,
  // so `sign` only appends the buyer's signature.
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.tx_base64, "base64"));
  tx.sign([keypair]);
  const signedTxBase64 = Buffer.from(tx.serialize()).toString("base64");

  const { x_payment } = encodeX402Payment({ accept, signedTxBase64, resourceUrl });

  return { header: x_payment, payer: keypair.publicKey.toBase58() };
}
