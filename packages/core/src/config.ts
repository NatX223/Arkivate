import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key");

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const EnvSchema = z.object({
  ARKIV_RPC_HTTP: z.url().default("https://rpc.tiramisu.db-chain.testnet.arkiv.network"),
  ARKIV_RPC_WS: z.url().default("wss://rpc.tiramisu.db-chain.testnet.arkiv.network"),
  ARKIV_ACCESS_KEY: optional(z.string()),
  OWNER_PRIVATE_KEY: optional(privateKey),
  SEALED_OWNER_PRIVATE_KEY: optional(privateKey),
  WORKER_A_PRIVATE_KEY: optional(privateKey),
  WORKER_B_PRIVATE_KEY: optional(privateKey),
  WORKER_PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_ENDPOINT: optional(z.url()),
  TELEGRAM_BOT_TOKEN: optional(z.string()),
});

export type Env = z.infer<typeof EnvSchema>;
export type EnvKey = keyof Env;

/** Walk up from cwd to find the repo's .env, so scripts work from any package dir. */
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
