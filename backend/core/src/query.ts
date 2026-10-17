import { addr, bool, i32, key, str, u64, type ArkivValue } from "@arkiv-network/sdk/attr";
import { and, eq, gt, gte, lt, lte, startsWith, type Expression } from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import type { ComparisonOp, Predicate, TypedLiteral } from "./spec.js";

/** Anything that filters by query: on_create / on_silence / on_count conditions, or a query watch. */
export interface QueryFilter {
  where: readonly Predicate[];
  created_by?: string | undefined;
}

export function toValue(lit: TypedLiteral): ArkivValue {
  if ("str" in lit) return str(lit.str);
  if ("u64" in lit) return u64(BigInt(lit.u64));
  if ("i32" in lit) return i32(lit.i32);
  if ("addr" in lit) return addr(lit.addr as Hex);
  if ("key" in lit) return key(lit.key as Hex);
  return bool(lit.bool);
}

const COMPARE = { eq, gt, gte, lt, lte } as const satisfies Record<ComparisonOp, unknown>;

export function toExpression([op, name, lit]: Predicate): Expression {
  if (op === "starts_with") return startsWith(name, str((lit as { str: string }).str));
  return COMPARE[op](name, toValue(lit));
}

/**
 * The condition's filter as one SDK expression, including the trusted creator. Render it with
 * `String(expr)` to get the exact query text the node parses (also what the raw count RPC takes).
 */
export function conditionExpression(cond: QueryFilter, extra: Expression[] = []): Expression {
  const parts = cond.where.map(toExpression);
  if (cond.created_by) parts.push(eq("$creator", addr(cond.created_by as Hex)));
  return and([...parts, ...extra]);
}

/** Does `actual` satisfy `op value`? Used for on_count thresholds. */
export function compare(actual: number, op: ComparisonOp, value: number): boolean {
  switch (op) {
    case "eq":
      return actual === value;
    case "gt":
      return actual > value;
    case "gte":
      return actual >= value;
    case "lt":
      return actual < value;
    case "lte":
      return actual <= value;
  }
}

/** An entity row as the SDK decodes it: typed attribute values and its creator. */
export interface CandidateRow {
  key: Hex;
  creator: Hex;
  createdAt: bigint;
  expiresAt: bigint;
  attributes: Record<string, { type: string; value: unknown } | undefined>;
}

/**
 * Evaluate a filter locally against an already-fetched row, so one query for a batch of new
 * entities can serve every trigger (each `arkiv_query` costs 100 units). Conservative: returns
 * `undefined` whenever the node's semantics aren't certain (string ordering, ordered compares on
 * addresses and keys), and the caller asks the node instead.
 */
export function localMatch(row: CandidateRow, f: QueryFilter): boolean | undefined {
  if (f.created_by && row.creator.toLowerCase() !== f.created_by.toLowerCase()) return false;
  let unsure = false;
  for (const [op, name, lit] of f.where) {
    const a = row.attributes[name];
    const want = Object.keys(lit)[0] as keyof TypedLiteral;
    // Typed compare: a value of another type never matches (the node's bare-number trap).
    if (!a || a.type !== want) return false;
    const v = (lit as Record<string, unknown>)[want];
    let ok: boolean | undefined;
    if (op === "starts_with") ok = typeof a.value === "string" && a.value.startsWith(String(v));
    else if (want === "u64") ok = compareBig(BigInt(a.value as bigint), op, BigInt(v as string));
    else if (want === "i32") ok = compareBig(BigInt(a.value as number), op, BigInt(v as number));
    else if (op !== "eq") ok = undefined;
    else if (want === "addr" || want === "key") ok = String(a.value).toLowerCase() === String(v).toLowerCase();
    else ok = a.value === v;
    if (ok === false) return false;
    if (ok === undefined) unsure = true;
  }
  return unsure ? undefined : true;
}

function compareBig(actual: bigint, op: ComparisonOp, value: bigint): boolean {
  switch (op) {
    case "eq":
      return actual === value;
    case "gt":
      return actual > value;
    case "gte":
      return actual >= value;
    case "lt":
      return actual < value;
    case "lte":
      return actual <= value;
  }
}
