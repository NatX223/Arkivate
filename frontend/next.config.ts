import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

// Locally, reuse the repo-root .env for the read proxy, but copy only the two variables it needs:
// the root file also holds private keys, which have no business in the web server's environment.
// On Vercel the file is absent and these come from the project's env settings.
const SERVER_ENV = ["ARKIV_RPC_HTTP", "ARKIV_ACCESS_KEY"] as const;
try {
  const root = parseEnv(readFileSync(join(process.cwd(), "..", ".env"), "utf8"));
  for (const name of SERVER_ENV) {
    if (!process.env[name] && root[name]) process.env[name] = root[name];
  }
} catch {
  // no root .env: fine
}

const nextConfig: NextConfig = {
  // Monorepo: trace server files from the repo root so @arkivate/core is bundled on Vercel.
  outputFileTracingRoot: join(process.cwd(), ".."),
  // @arkivate/core ships TypeScript source. Import only "@arkivate/core", never
  // "@arkivate/core/server" (it reads env and private keys).
  transpilePackages: ["@arkivate/core"],
  // Core is NodeNext TypeScript (`import "./spec.js"` means spec.ts). Webpack can map that;
  // Turbopack can't yet, so the app builds with webpack (arkiv/friction.md F18).
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    return config;
  },
};

export default nextConfig;
