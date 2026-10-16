import type { Hex } from "viem";

/**
 * The owner's private half of a sealed trigger: spec + salt. Same shape as the CLI's
 * `~/.arkivate/sealed/<key>.json`, so a downloaded backup works with `arkivate reveal --file`.
 * Kept in this browser only. The alert destination is deliberately not part of it.
 */
export interface SealedFile {
  sealed_key: Hex;
  spec: unknown;
  salt: Hex;
  commitment: Hex;
  worker: Hex;
  endpoint: string;
  created_at: string;
}

const PREFIX = "arkivate.sealed.";

export function saveSealed(f: SealedFile) {
  try {
    localStorage.setItem(PREFIX + f.sealed_key.toLowerCase(), JSON.stringify(f));
  } catch {
    // storage blocked: the download backup is the fallback
  }
}

export function readSealed(k: string): SealedFile | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + k.toLowerCase());
    return raw ? (JSON.parse(raw) as SealedFile) : undefined;
  } catch {
    return undefined;
  }
}

export function parseSealedFile(text: string): SealedFile {
  const f = JSON.parse(text) as Partial<SealedFile>;
  if (typeof f.sealed_key !== "string" || typeof f.salt !== "string" || f.spec === undefined) {
    throw new Error("not an Arkivate sealed backup (needs sealed_key, spec and salt)");
  }
  return f as SealedFile;
}

export function downloadSealed(f: SealedFile) {
  const blob = new Blob([JSON.stringify(f, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `arkivate-sealed-${f.sealed_key.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
