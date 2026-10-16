import canonicalize from "canonicalize";
import { bytesToHex, concat, keccak256, stringToHex, type Hex } from "viem";

/**
 * commitment = keccak256(canonical_json(spec) ‖ salt32) — see docs/technical-plan.md §3.
 * Both parts must be the same kind for viem's `concat`: mixing a Uint8Array with a hex string
 * (as in the plan's original snippet) silently drops the salt.
 */
export function commit(spec: unknown, salt32: Hex): Hex {
  const canonical = canonicalize(spec);
  if (canonical === undefined) throw new Error("spec is not JSON-serialisable");
  return keccak256(concat([stringToHex(canonical), salt32]));
}

/**
 * 32 random bytes from Web Crypto (Node ≥ 19 and browsers alike). The salt is what keeps a sealed
 * spec from being brute-forced from its commitment, so it must never be reused or derived.
 */
export function randomSalt(): Hex {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}
