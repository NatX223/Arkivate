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
