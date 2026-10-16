/** Tiramisu produces a block roughly every 2 s; used only to turn block deltas into human time. */
export const BLOCK_SECONDS = 2;

export const short = (h: string | undefined, head = 6, tail = 4) =>
  !h ? "" : h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;

export const fmtBlock = (b: bigint | number | undefined) => (b === undefined ? "—" : `#${Number(b).toLocaleString("en-US")}`);

export const blocksToSeconds = (blocks: bigint | number) => Number(blocks) * BLOCK_SECONDS;
export const minutesToBlocks = (min: number) => Math.max(1, Math.round((min * 60) / BLOCK_SECONDS));
export const blocksToMinutes = (blocks: number) => (blocks * BLOCK_SECONDS) / 60;

/** "2h 14m", "8m 40s", "3d 4h". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Human length of a block count, for spec summaries: "30 minutes", "1 hour", "4 hours". */
export function fmtSpan(blocks: number): string {
  const min = blocksToMinutes(blocks);
  if (min < 1) return `${blocks * BLOCK_SECONDS} seconds`;
  if (min < 90) return `${Math.round(min)} minute${Math.round(min) === 1 ? "" : "s"}`;
  const h = min / 60;
  if (h < 48) return `${+h.toFixed(1)} hour${h === 1 ? "" : "s"}`;
  return `${+(h / 24).toFixed(1)} days`;
}

/** Time from `from` to `to` in blocks, as "4 min ago" / "in 5h 08m". */
export function relBlocks(block: bigint | undefined, head: bigint | undefined): string {
  if (block === undefined || head === undefined) return "";
  const delta = Number(head - block) * BLOCK_SECONDS;
  if (delta < 0) return `in ${fmtDuration(-delta)}`;
  if (delta < 10) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} h ago`;
  return `${Math.floor(delta / 86400)} d ago`;
}

export const sameAddr = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** viem / proxy errors that mean the read quota is spent. */
export function isRateLimited(e: unknown): boolean {
  const msg = errMessage(e);
  return /\b429\b|rate.?limit|too many requests|quota/i.test(msg);
}

export const jsonStringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
