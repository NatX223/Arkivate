import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { TIRAMISU_RPC_HTTP, TIRAMISU_RPC_WS } from "./constants.js";

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key");

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
  /** Set by Cloud Run; takes precedence over WORKER_PORT. */
  PORT: optional(z.coerce.number().int().positive()),
  DATA_DIR: optional(z.string()),
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
  /** Origins allowed to call `POST /sealed` from a browser (comma-separated, or `*`). */
  CORS_ORIGINS: z.string().default("*"),
  TELEGRAM_BOT_TOKEN: optional(z.string()),
});

export type Env = z.infer<typeof EnvSchema>;
export type EnvKey = keyof Env;

/** Walk up from cwd to find the repo's .env. Missing is fine: deployments use real env vars. */
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
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
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
      throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
    }
    cached = parsed.data;
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
