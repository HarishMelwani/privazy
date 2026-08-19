import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
// @ts-ignore - generated artifact
import {
  PrivAZyContract,
  PrivAZyContractArtifact,
} from './generated/PrivAZy';
import { createSponsoredFeePayment } from './fees';
import { getNodeUrl, PRIVAZY_CONTRACT_ADDRESS } from './config';

export const CONTENT_FIELD_LEN = 6;
export const MAX_CONTENT_BYTES = CONTENT_FIELD_LEN * 31;

/** Byte length of text as UTF-8 (matches the on-chain 217-byte limit). */
export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Validate an Aztec address string before sending. */
export function isValidAddress(value: string): boolean {
  const v = value.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(v);
}

export function encodeText(text: string): Fr[] {
  const bytes = new TextEncoder().encode(text);
  const fields: Fr[] = [];
  for (let i = 0; i < CONTENT_FIELD_LEN; i++) {
    let n = 0n;
    for (let j = 0; j < 31 && i * 31 + j < bytes.length; j++) {
      n = (n << 8n) | BigInt(bytes[i * 31 + j]);
    }
    fields.push(new Fr(n));
  }
  return fields;
}

export function decodeText(fields: Fr[] | bigint[]): string {
  const bytes: number[] = [];
  for (let i = 0; i < CONTENT_FIELD_LEN && i < fields.length; i++) {
    const n = BigInt(fields[i].toString());
    let v = n;
    const chunk = new Array<number>(31).fill(0);
    for (let j = 31 - 1; j >= 0; j--) {
      chunk[j] = Number(v & 0xffn);
      v >>= 8n;
    }
    const first = chunk.findIndex((b) => b !== 0);
    if (first === -1) {
      break;
    }
    for (let j = first; j < 31; j++) {
      bytes.push(chunk[j]);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export async function attachToPrivAZy(
  wallet: Wallet,
  contractAddress: AztecAddress = AztecAddress.fromStringUnsafe(PRIVAZY_CONTRACT_ADDRESS),
) {
  const node = createAztecNodeClient(getNodeUrl());
  const instance = await node.getContract(contractAddress);
  if (!instance) {
    throw new Error(`Contract not found onchain at ${contractAddress}`);
  }
  await wallet.registerContract(instance, PrivAZyContractArtifact);
  return PrivAZyContract.at(contractAddress, wallet);
}

export async function sendMessage(
  contract: PrivAZyContract,
  from: AztecAddress,
  to: AztecAddress,
  text: string,
) {
  const paymentMethod = await createSponsoredFeePayment();
  const receipt = await contract.methods
    .send(to, encodeText(text))
    .send({ from, fee: { paymentMethod } });
  return receipt;
}

export interface InboxMessage {
  sender: string;
  content: string;
  timestamp: number;
}

export interface OutboxMessage {
  recipient: string;
  content: string;
  timestamp: number;
}

export async function getInbox(
  contract: PrivAZyContract,
  owner: AztecAddress,
): Promise<InboxMessage[]> {
  const sim = await contract.methods.get_inbox(owner).simulate({ from: owner });
  const result = sim.result as {
    len: number;
    storage: { sender: AztecAddress; timestamp: bigint; content: Fr[] }[];
  };
  if (!result || !result.storage) {
    return [];
  }
  const zero = AztecAddress.ZERO.toString();
  const len = Number(result.len);
  return result.storage
    .slice(0, len)
    .filter((m) => m.sender.toString() !== zero)
    .map((m) => ({
      sender: m.sender.toString(),
      content: decodeText(m.content),
      timestamp: Number(m.timestamp),
    }));
}

export async function getOutbox(
  contract: PrivAZyContract,
  owner: AztecAddress,
): Promise<OutboxMessage[]> {
  const sim = await contract.methods.get_outbox(owner).simulate({ from: owner });
  const result = sim.result as {
    len: number;
    storage: { recipient: AztecAddress; timestamp: bigint; content: Fr[] }[];
  };
  if (!result || !result.storage) {
    return [];
  }
  const zero = AztecAddress.ZERO.toString();
  const len = Number(result.len);
  return result.storage
    .slice(0, len)
    .filter((m) => m.recipient.toString() !== zero)
    .map((m) => ({
      recipient: m.recipient.toString(),
      content: decodeText(m.content),
      timestamp: Number(m.timestamp),
    }));
}
