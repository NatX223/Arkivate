import canonicalize from "canonicalize";
import { addr, bytes32, key, u64 } from "@arkiv-network/sdk/attr";
import { concat, keccak256, stringToHex, type Hex } from "viem";
import { ENTITY_TYPES, PROJECT } from "./constants.js";

/**
 * Sealed triggers (docs/technical-plan.md §3, §6).
 *
 * On Arkiv: `sealed` (commitment + chosen worker), `acceptance` (worker's burned promise), sealed
 * receipts (`{ result_hash }` only) and, only in a dispute, `reveal` (`{ spec, salt }`).
 * Never on Arkiv: the destination (webhook URL / chat ID), in plaintext or hashed.
 */

export type DestinationType = "webhook" | "telegram";
export interface Destination {
  type: DestinationType;
  value: string;
}

/** Body of `POST /sealed` on the chosen worker. */
export interface HandoffRequest {
  sealed_key: Hex;
  spec: unknown;
  salt: Hex;
  destination: Destination;
  signature: Hex;
}

/**
 * Local-only digest of the destination. It binds the owner's signature to this exact hand-off
 * (so a relay can't swap the destination) and is never written on-chain.
 */
export function destinationDigest(d: Destination): Hex {
  return keccak256(stringToHex(canonicalize(d)!));
}

/** The exact text the sealed owner signs with EIP-191 `personal_sign`. */
export function handoffMessage(p: {
  sealedKey: Hex;
  commitment: Hex;
  workerAddress: Hex;
  destinationDigest: Hex;
}): string {
  return [
    "Arkivate sealed hand-off v1",
    `sealed: ${p.sealedKey.toLowerCase()}`,
    `commitment: ${p.commitment.toLowerCase()}`,
    `worker: ${p.workerAddress.toLowerCase()}`,
    `destination: ${p.destinationDigest.toLowerCase()}`,
  ].join("\n");
}

/**
 * On-chain epoch of a sealed receipt. The raw epoch (e.g. `create:<matched_key>`) would reveal
 * which entity matched, and so the sealed intent; its hash is still stable for dedupe, and anyone
 * holding the revealed spec can recompute it.
 */
export const sealedEpoch = (rawEpoch: string): Hex => keccak256(stringToHex(rawEpoch));

/** Sealed receipt payload: `keccak(epoch ‖ matched_key)` — proves what fired without saying it. */
export const resultHash = (rawEpoch: string, matchedKey?: Hex): Hex =>
  keccak256(concat([stringToHex(rawEpoch), matchedKey ?? "0x"]));

export function sealedAttributes(commitment: Hex, worker: Hex) {
  return {
    project: PROJECT,
    entity_type: ENTITY_TYPES.sealed,
    commitment: bytes32(commitment),
    worker: addr(worker),
    created_at: u64(Date.now()),
  };
}

/**
 * The worker's promise. Carries the commitment and the sealed creator too, so a dispute can still
 * be verified after the `sealed` entity itself expires.
 */
export function acceptanceAttributes(sealedKey: Hex, commitment: Hex, sealedCreator: Hex, acceptedBlock: bigint) {
  return {
    project: PROJECT,
    entity_type: ENTITY_TYPES.acceptance,
    sealed: key(sealedKey),
    commitment: bytes32(commitment),
    sealed_creator: addr(sealedCreator),
    accepted_block: u64(acceptedBlock),
  };
}

export function revealAttributes(sealedKey: Hex) {
  return { project: PROJECT, entity_type: ENTITY_TYPES.reveal, sealed: key(sealedKey) };
}
