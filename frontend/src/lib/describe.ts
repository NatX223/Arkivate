import type { ComparisonOp, Predicate, TriggerSpec, Watch } from "@arkivate/core";
import { blocksToMinutes, fmtSpan, short } from "./format";

/** Plain-English pieces of a TriggerSpec, for tables, headlines and the create review step. */

type Cond = TriggerSpec["cond"];
type Action = TriggerSpec["action"];

export const CONDITION_LABEL: Record<Cond["type"], string> = {
  on_expiring: "About to expire",
  on_expire: "Expired",
  on_extend: "Renewed",
  on_delete: "Deleted",
  on_silence: "Went quiet",
  on_create: "New entity",
  on_count: "Count",
};

/** Filter-chip key per condition (Triggers page). */
export const CONDITION_GROUP: Record<Cond["type"], string> = {
  on_expiring: "expiring",
  on_expire: "expired",
  on_extend: "renewed",
  on_delete: "deleted",
  on_silence: "quiet",
  on_create: "new",
  on_count: "count",
};

const OP_TEXT: Record<ComparisonOp, string> = { eq: "=", gt: ">", gte: "≥", lt: "<", lte: "≤" };

function literal(p: Predicate): string {
  const lit = p[2] as Record<string, unknown>;
  const v = Object.values(lit)[0];
  return typeof v === "string" && /^0x[0-9a-fA-F]{40,}$/.test(v) ? short(v) : String(v);
}

/** "demo_feed · listing" from a where list: the readable part of a query. */
export function whereLabel(where: readonly Predicate[]): string {
  const get = (n: string) => where.find((p) => p[0] === "eq" && p[1] === n);
  const project = get("project");
  const type = get("entity_type");
  const rest = where.filter((p) => p !== project && p !== type);
  const parts: string[] = [];
  if (project && literal(project) !== "arkivate") parts.push(literal(project));
  if (type) parts.push(literal(type));
  for (const p of rest) parts.push(p[0] === "eq" ? literal(p) : `${p[1]} ${p[0] === "starts_with" ? "starts with" : OP_TEXT[p[0] as ComparisonOp]} ${literal(p)}`);
  return parts.join(" · ") || "matching entities";
}

export interface WatchInfo {
  label: string;
  /** Entity key, for single-entity watches. */
  key?: string;
  createdBy?: string;
}

export function watchInfo(c: Cond): WatchInfo {
  if ("watch" in c) return fromWatch(c.watch);
  return { label: whereLabel(c.where), createdBy: c.created_by };
}

function fromWatch(w: Watch): WatchInfo {
  if ("entity_key" in w) return { label: "entity", key: w.entity_key };
  return { label: whereLabel(w.where), createdBy: w.created_by };
}

/** The condition argument shown under the condition name in tables. */
export function conditionArg(c: Cond): string {
  switch (c.type) {
    case "on_expiring":
      return `${fmtSpan(c.lead_blocks)} before · ${c.deadline === "pinned" ? "pinned" : "follow renewals"}`;
    case "on_expire":
      return c.deadline === "pinned" ? "pinned deadline" : "follow renewals";
    case "on_silence":
      return `${fmtSpan(c.silence_blocks)} silent`;
    case "on_count":
      return `count ${OP_TEXT[c.count_op]} ${c.count_value}`;
    case "on_create":
      return c.created_by ? `from ${short(c.created_by)}` : "from anyone";
    default:
      return "any change";
  }
}

export function actionLabel(a: Action): { text: string; kind: "reactivate" | "notice" | "alert" } {
  if (a.type === "extend") return { text: `↻ Reactivate +${compactSpan(a.extend_blocks)} ×${a.max_extensions}`, kind: "reactivate" };
  if (a.type === "notice") return { text: "Notice", kind: "notice" };
  return { text: `⚑ Alert · ${a.type}`, kind: "alert" };
}

const subject = (w: WatchInfo) => (w.key ? `entity ${short(w.key)}` : `${w.label}${w.createdBy ? ` from ${short(w.createdBy)}` : ""}`);

/** One sentence: "30 minutes before demo_feed · listing expires, renew it for 4 minutes, up to 2 times." */
export function describeSpec(spec: TriggerSpec): string {
  const c = spec.cond;
  const w = watchInfo(c);
  const what = subject(w);
  const pinned = "deadline" in c && c.deadline === "pinned" ? " The deadline is pinned, so later renewals can't delay it." : "";
  let when: string;
  switch (c.type) {
    case "on_expiring":
      when = `${cap(fmtSpan(c.lead_blocks))} before ${what} expires`;
      break;
    case "on_expire":
      when = `When ${what} expires`;
      break;
    case "on_extend":
      when = `When ${what} is renewed`;
      break;
    case "on_delete":
      when = `When ${what} is deleted`;
      break;
    case "on_create":
      when = `When a new ${what} appears`;
      break;
    case "on_silence":
      when = `When ${what} goes quiet for ${fmtSpan(c.silence_blocks)}`;
      break;
    case "on_count":
      when = `When the number of ${what} entities is ${OP_TEXT[c.count_op]} ${c.count_value}`;
      break;
  }
  const a = spec.action;
  const then =
    a.type === "extend"
      ? `renew it for ${fmtSpan(a.extend_blocks)}, up to ${a.max_extensions} time${a.max_extensions === 1 ? "" : "s"}`
      : a.type === "notice"
        ? "post a public receipt"
        : `send a ${a.type === "telegram" ? "Telegram alert" : "webhook call"}`;
  return `${when}, ${then}.${pinned}`;
}

/** "4m", "2h", "1.5d": for badges where a full "4 minutes" won't fit. */
function compactSpan(blocks: number): string {
  const min = blocksToMinutes(blocks);
  if (min < 90) return `${Math.max(1, Math.round(min))}m`;
  if (min < 48 * 60) return `${+(min / 60).toFixed(1)}h`;
  return `${+(min / 1440).toFixed(1)}d`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
