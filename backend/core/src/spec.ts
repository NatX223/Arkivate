import { z } from "zod";

// TODO(phase 1): full TriggerSpec per docs/technical-plan.md §4.
// Typed literals ({u64}, {str}) map to SDK u64()/str() so queries never fall into the i32 trap.
export const TypedLiteral = z.union([
  z.object({ str: z.string() }).strict(),
  z.object({ u64: z.string().regex(/^\d+$/) }).strict(),
]);

export const ConditionType = z.enum(["on_create", "on_silence", "on_count"]);

export const TriggerSpec = z.object({
  v: z.literal(1),
  cond: z.object({ type: ConditionType }).passthrough(),
  action: z.object({ type: z.enum(["notice", "webhook", "telegram"]) }),
});
export type TriggerSpec = z.infer<typeof TriggerSpec>;
