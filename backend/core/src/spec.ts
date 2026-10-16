import { z } from "zod";

/**
 * Trigger spec v1 — see docs/technical-plan.md §4.
 *
 * Literals are explicitly typed ({str}, {u64}, …) and map 1:1 to SDK `str()` / `u64()` / …, so a
 * spec can never fall into the bare-number-is-i32 trap that silently matches nothing.
 */

const uint = z.string().regex(/^\d+$/, "must be a base-10 unsigned integer string");
const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");
const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte key");

export const TypedLiteral = z.union([
  z.object({ str: z.string() }).strict(),
  z.object({ u64: uint }).strict(),
  z.object({ i32: z.number().int().min(-(2 ** 31)).max(2 ** 31 - 1) }).strict(),
  z.object({ addr: hexAddress }).strict(),
  z.object({ key: hexKey }).strict(),
  z.object({ bool: z.boolean() }).strict(),
]);
export type TypedLiteral = z.infer<typeof TypedLiteral>;

/** User attribute names only: lowercase snake_case (the node rejects uppercase), ≤32 bytes. */
export const AttributeName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "must be lowercase snake_case, ≤32 chars, not a $system name");

// Only operators the node accepts (ne / exists / hasType are exported by the SDK but rejected).
export const ComparisonOp = z.enum(["eq", "gt", "gte", "lt", "lte"]);
export type ComparisonOp = z.infer<typeof ComparisonOp>;

export const Predicate = z.union([
  z.tuple([ComparisonOp, AttributeName, TypedLiteral]),
  z.tuple([z.literal("starts_with"), AttributeName, z.object({ str: z.string() }).strict()]),
]);
export type Predicate = z.infer<typeof Predicate>;

const base = {
  where: z.array(Predicate).min(1, "at least one predicate is required"),
  /** Trusted creator → `.createdBy()`. The only authentication Arkiv offers. */
  created_by: hexAddress.optional(),
};

export const OnCreate = z
  .object({ type: z.literal("on_create"), ...base })
  .strict();

export const OnSilence = z
  .object({
    type: z.literal("on_silence"),
    ...base,
    // Required: silence of *anyone* is meaningless, and it is the extension-attack defence.
    created_by: hexAddress,
    silence_blocks: z.number().int().positive(),
  })
  .strict();

export const OnCount = z
  .object({
    type: z.literal("on_count"),
    ...base,
    count_op: ComparisonOp,
    count_value: z.number().int().nonnegative(),
  })
  .strict();

/**
 * What an expiry-family condition watches: one entity by key, or every entity matching a query.
 * The query form is the same `{ where, created_by? }` the other conditions use.
 */
export const EntityWatch = z.object({ entity_key: hexKey }).strict();
export const QueryWatch = z.object({ ...base }).strict();
export const Watch = z.union([EntityWatch, QueryWatch]);
export type Watch = z.infer<typeof Watch>;

/**
 * Which deadline the expiry conditions measure against:
 * - `follow`: the entity's current `expiresAt`. An extension moves the deadline.
 * - `pinned`: `expiresAt` when the trigger first saw the entity. Extensions (by anyone) do not
 *   move it, so a third party cannot keep postponing the deadline.
 */
export const Deadline = z.enum(["follow", "pinned"]);

export const OnExpiring = z
  .object({
    type: z.literal("on_expiring"),
    watch: Watch,
    lead_blocks: z.number().int().positive(),
    deadline: Deadline.default("follow"),
  })
  .strict();

export const OnExpire = z
  .object({ type: z.literal("on_expire"), watch: Watch, deadline: Deadline.default("follow") })
  .strict();

export const OnExtend = z.object({ type: z.literal("on_extend"), watch: Watch }).strict();
export const OnDelete = z.object({ type: z.literal("on_delete"), watch: Watch }).strict();

export const Condition = z.discriminatedUnion("type", [
  OnCreate,
  OnSilence,
  OnCount,
  OnExpiring,
  OnExpire,
  OnExtend,
  OnDelete,
]);
export type Condition = z.infer<typeof Condition>;
export type ConditionType = Condition["type"];
export const EXPIRY_CONDITIONS = ["on_expiring", "on_expire", "on_extend", "on_delete"] as const;
export type ExpiryCondition = Extract<Condition, { type: (typeof EXPIRY_CONDITIONS)[number] }>;
export const isExpiryCondition = (c: Condition): c is ExpiryCondition =>
  (EXPIRY_CONDITIONS as readonly string[]).includes(c.type);

export const MAX_EXTENSIONS_CAP = 100;

export const NoticeAction = z.object({ type: z.literal("notice") }).strict();
/** Reactivate: extend the watched entity before it expires. Public, because it acts on-chain. */
export const ExtendAction = z
  .object({
    type: z.literal("extend"),
    extend_blocks: z.number().int().positive(),
    max_extensions: z.number().int().positive().max(MAX_EXTENSIONS_CAP),
  })
  .strict();
export const PublicAction = z.discriminatedUnion("type", [NoticeAction, ExtendAction]);
export const SealedAction = z.object({ type: z.enum(["webhook", "telegram"]) }).strict();

const SpecShape = z
  .object({
    v: z.literal(1),
    cond: Condition,
    action: z.union([PublicAction, SealedAction]),
  })
  .strict();

/**
 * Combinations the schema alone can't express. `extend` only makes sense before expiry:
 * `on_extend` + `extend` would loop (our extension re-triggers it), and after `on_expire` /
 * `on_delete` there is nothing left to extend.
 */
function checkCombination(spec: z.infer<typeof SpecShape>, ctx: z.RefinementCtx) {
  if (spec.action.type !== "extend") return;
  if (spec.cond.type === "on_expiring") return;
  const reason =
    spec.cond.type === "on_extend"
      ? "on_extend + extend is a loop: each extension would fire the trigger again"
      : `extend is only valid with on_expiring (got ${spec.cond.type})`;
  ctx.addIssue({ code: "custom", path: ["action", "type"], message: reason });
}

export const TriggerSpec = SpecShape.superRefine(checkCombination);
export type TriggerSpec = z.infer<typeof TriggerSpec>;

/** A spec that may be posted publicly: `notice` (receipt only) or `extend` (Reactivate). */
export const PublicTriggerSpec = SpecShape.extend({ action: PublicAction }).superRefine(checkCombination);
export type PublicTriggerSpec = z.infer<typeof PublicTriggerSpec>;

/** Parse with a readable, path-qualified error. */
export function parseSpec<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid trigger spec:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
