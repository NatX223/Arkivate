import canonicalize from "canonicalize";
import { concat, keccak256, stringToHex, type Hex } from "viem";

// TODO(phase 2): salt generation, verification helpers.
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
