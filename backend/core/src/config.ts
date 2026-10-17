import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { TIRAMISU_RPC_HTTP, TIRAMISU_RPC_WS } from "./constants.js";

// Accepted with or without the 0x prefix; always normalised to 0x-prefixed.
const privateKey = z.preprocess(
  (v) => (typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v.trim()) ? `0x${v.trim()}` : typeof v === "string" ? v.trim() : v),
  z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex private key (64 hex chars, 0x optional)"),
);

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const EnvSchema = z.object({
  ARKIV_RPC_HTTP: z.url().default(TIRAMISU_RPC_HTTP),
  ARKIV_RPC_WS: z.url().default(TIRAMISU_RPC_WS),
  ARKIV_ACCESS_KEY: optional(z.string()),
  OWNER_PRIVATE_KEY: optional(privateKey),
  SEALED_OWNER_PRIVATE_KEY: optional(privateKey),
  // One worker identity per deployment (worker-a, worker-b), see docs/structure.md.
  WORKER_NAME: z.string().default("worker-local"),
  WORKER_PRIVATE_KEY: optional(privateKey),
  WORKER_PORT: z.coerce.number().int().positive().default(8787),
  /** Takes precedence over WORKER_PORT when a host sets it. */
  PORT: optional(z.coerce.number().int().positive()),
  /** Bind address. Default: 127.0.0.1 when NODE_ENV=production (behind Caddy), else 0.0.0.0. */
  HOST: optional(z.string()),
  NODE_ENV: optional(z.string()),
  /** Reported by /health when `git rev-parse` is unavailable. */
  GIT_SHA: optional(z.string()),
  /** Job store directory; absolute, or relative to the working directory. */
  DATA_DIR: optional(z.string().transform((v) => (isAbsolute(v) ? v : resolve(v)))),
  PUBLIC_ENDPOINT: optional(z.url()),
  /** Spam/gas guard: only run triggers created by these addresses. Empty = accept all. */
  TRIGGER_CREATORS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^0x[0-9a-f]{40}$/, "must be comma-separated 0x addresses"))),
  /** Spam/gas guard: receipts (each one costs gas) a worker writes per trigger per hour. */
  MAX_RECEIPTS_PER_TRIGGER_PER_HOUR: z.coerce.number().int().positive().default(12),
  /**
   * DEMO SWITCH: accept sealed jobs but never fire them, to stage the censorship demo. Off by
   * default; never enable on a worker you want people to trust.
   */
  SKIP_SEALED: z.enum(["true", "false", ""]).default("false").transform((v) => v === "true"),
  /** Browser origins allowed on /health and POST /sealed: comma-separated, exact match. */
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((v) => v.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean))
    .pipe(z.array(z.string().regex(/^https?:\/\/[^/\s*]+$/, "must be comma-separated origins like https://app.example.com (no * or paths)"))),
  TELEGRAM_BOT_TOKEN: optional(z.string()),
  /**
   * Read budget (arkiv/friction.md F20). Expiry sweep, silence/count pollers, full refresh of
   * triggers + workers, and the batch window for WS-created entities. Receipts are only read
   * when a trigger is about to fire.
   */
  SWEEP_SECONDS: z.coerce.number().int().positive().default(30),
  POLL_SECONDS: z.coerce.number().int().positive().default(30),
  REFRESH_SECONDS: z.coerce.number().int().positive().default(600),
  FLUSH_SECONDS: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof EnvSchema>;
export type EnvKey = keyof Env;

/** This file is backend/core/src/config.ts, so the repo root is three levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Walk up from cwd to find the repo's .env, falling back to the repo root (so a service started
 * from any directory still finds /opt/arkivate/.env). Missing is fine: hosts may set real env vars.
 */
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const root = join(REPO_ROOT, ".env");
  return existsSync(root) ? root : undefined;
}

/** Validate raw env. Errors name the variable and the rule it broke, never the value. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  // A blank value (`WORKER_PORT=` in a copied template) means "unset", so defaults apply.
  const set = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(set);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

let cached: Env | undefined;

/**
 * Load and validate env. Errors name the variable and the rule it broke, never the value.
 * `required` lists variables that must be present for the calling program.
 */
export function loadConfig(required: readonly EnvKey[] = []): Env {
  if (!cached) {
    const path = findEnvFile();
    if (path) loadDotenv({ path: resolve(path), quiet: true });
    cached = parseEnv(process.env);
  }
  const missing = required.filter((k) => cached![k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them in .env (see .env.example).`,
    );
  }
  return cached;
}
