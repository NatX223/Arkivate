import type { Receipt, PublicTrigger } from "./data";
import { CONDITION_LABEL } from "./describe";
import type { Tone } from "@/components/ui";

export interface ReceiptLabel {
  text: string;
  tone: Tone;
}

/** What a receipt says happened, from its attributes and (for public ones) its trigger. */
export function receiptLabel(r: Receipt, trigger?: PublicTrigger): ReceiptLabel {
  if (r.mode === "sealed") return { text: "🔒 Sealed", tone: "sealed" };
  if (r.outcome === "extended") return { text: "↻ Reactivated", tone: "accent" };
  if (r.outcome === "not_extendable") return { text: "⚠ Not renewable", tone: "warning" };
  if (r.outcome === "cap_reached") return { text: "Renewal cap reached", tone: "warning" };
  const cond = trigger?.spec.cond.type;
  return { text: cond ? `Notice · ${CONDITION_LABEL[cond].toLowerCase()}` : "Notice", tone: "neutral" };
}

export const byKey = <T extends { key: string }>(xs: readonly T[] | undefined) => new Map((xs ?? []).map((x) => [x.key.toLowerCase(), x]));
