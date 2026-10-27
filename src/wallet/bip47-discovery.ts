import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha2";
import { p2pkh } from "@scure/btc-signer";
import type { HDKey } from "@scure/bip32";
import { script, type Transaction } from "bitcoinjs-lib";
import {
  notificationPublicKey,
  paymentCodeFromAccount,
  unblindPaymentCode,
} from "./bip47.ts";

export type DiscoveredBip47Notification = {
  senderPaymentCode: string;
  txid: string;
  designatedInputIndex: number;
};

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function compressedKey(key: Uint8Array): boolean {
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) return false;
  try { secp256k1.ProjectivePoint.fromHex(key).assertValidity(); return true; }
  catch { return false; }
}

/**
 * Supported exposed-key inputs: legacy signature script, native P2WPKH,
 * wrapped P2WPKH. Unknown earlier inputs are ambiguous without their prevouts:
 * they might expose a P2PK/multisig key there, so never skip past them.
 */
function designatedInput(tx: Transaction): { index: number; publicKey: Uint8Array } | null {
  for (const [index, input] of tx.ins.entries()) {
    const chunks = script.decompile(input.script);
    if (!chunks) return null;
    if (input.witness.length !== 0) {
      if (input.witness.length !== 2 || input.witness[0]!.length === 0 || !compressedKey(input.witness[1]!)) return null;
      const publicKey = input.witness[1]!;
      if (chunks.length === 0) return { index, publicKey };
      // Nested SegWit scriptSig must push exactly the matching witness program.
      if (chunks.length !== 1 || typeof chunks[0] === "number") return null;
      const redeem = chunks[0]!;
      if (redeem.length !== 22 || redeem[0] !== 0 || redeem[1] !== 20 ||
        !equal(redeem.slice(2), ripemd160(sha256(publicKey)))) return null;
      return { index, publicKey };
    }
    // A key pushed before the final pubkey remains the designated key. Do not
    // retry alternate keys when unblinding fails.
    for (const chunk of chunks) {
      if (typeof chunk === "number") continue;
      if (chunk.length === 65 && chunk[0] === 4) return null;
      if (chunk.length === 33 && (chunk[0] === 2 || chunk[0] === 3)) {
        return compressedKey(chunk) ? { index, publicKey: chunk } : null;
      }
    }
    // Cannot establish whether this input exposes a key in the spent script.
    return null;
  }
  return null;
}

/**
 * Call only for transactions whose active-chain inclusion is established by
 * the caller. Does not persist channels or make notification dust spendable.
 * Invalid/unrelated/ambiguous network data returns null rather than throwing.
 * BIP47 blinding is unauthenticated; discovery does not prove sender identity.
 */
export function discoverBip47Notification(
  tx: Transaction,
  recipientAccount: HDKey,
): DiscoveredBip47Notification | null {
  try {
    if (tx.isCoinbase()) return null;
    const ownCode = paymentCodeFromAccount(recipientAccount);
    const ownScript = p2pkh(notificationPublicKey(ownCode)).script;
    if (!tx.outs.some((output) => output.value > 0n && equal(output.script, ownScript))) return null;
    // A standard 80-byte data carrier has the minimal OP_RETURN PUSHDATA1 80
    // encoding. Reject multiple OP_RETURNs rather than selecting an attacker-
    // controlled candidate; no partially accepted channel is returned.
    const dataOutputs = tx.outs.filter((output) => output.script[0] === 0x6a);
    if (dataOutputs.length !== 1) return null;
    const data = dataOutputs[0]!;
    if (data.value !== 0n || data.script.length !== 83 || data.script[1] !== 0x4c || data.script[2] !== 80) return null;
    const designated = designatedInput(tx);
    if (!designated) return null;
    const input = tx.ins[designated.index]!;
    if (input.hash.length !== 32 || !Number.isInteger(input.index) || input.index < 0 || input.index > 0xffffffff) return null;
    const outpoint = new Uint8Array(36);
    // bitcoinjs input hashes already use the serialized (little-endian) order.
    outpoint.set(input.hash);
    new DataView(outpoint.buffer).setUint32(32, input.index, true);
    const senderPaymentCode = unblindPaymentCode({
      payload: data.script.slice(3), recipientAccount,
      designatedPublicKey: designated.publicKey, outpoint,
    });
    if (senderPaymentCode === ownCode) return null;
    return { senderPaymentCode, txid: tx.getId(), designatedInputIndex: designated.index };
  } catch {
    return null;
  }
}
