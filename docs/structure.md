# Arkivate — Repo Structure & Deployment

## Layout

pnpm monorepo: one repo, one lockfile, separate deployments (the frontend, and one per worker;
worker-1 and worker-2 are the reference workers we run).

```
Arkivate/                     ← root: shared config only
├─ package.json               # root scripts + dev tools
├─ pnpm-workspace.yaml        # backend/*, frontend
├─ tsconfig.base.json
├─ cloudbuild.yaml            # optional remote image build (unused by the reference deployment)
├─ .env.example               # local .env is gitignored
├─ .dockerignore
│
├─ deploy/vm/                 ← worker VM provisioning (setup.sh, update.sh, systemd unit, Caddyfile)
│
├─ arkiv/                     ← judge-required, must stay here
│  ├─ schema.md
│  └─ friction.md
│
├─ docs/                      ← prose only
│
├─ backend/
│  ├─ core/                   # shared library (never deployed alone)
│  │  └─ src/
│  │     ├─ index.ts          # browser-safe: constants, spec, commit, createReader
│  │     └─ server.ts         # server-only: env, private keys, wallet
│  ├─ worker/                 # DEPLOYED once per worker
│  │  ├─ Dockerfile        # optional; not used by the reference VMs
│  │  ├─ src/index.ts
│  │  └─ data/                # gitignored job store
│  ├─ cli/                    # runs locally, not deployed
│  └─ scripts/                # dev-only (hello.ts, gen-wallets.ts)
│
└─ frontend/                  # DEPLOYED (Vercel), Next.js
   └─ next.config.ts          # transpilePackages: ["@arkivate/core"]
```

## Rules

- `frontend` imports `@arkivate/core` only, **never** `@arkivate/core/server`.
- `worker`, `cli` and `scripts` may import both.
- No build step: the worker runs TypeScript via `tsx`, and Next transpiles `core`.
- Env vars come from `process.env`. The root `.env` is loaded locally if present and skipped if missing.

## Deployment

| What | Where | How |
|---|---|---|
| Frontend | Vercel | Root Directory = `frontend`; env `ARKIV_ACCESS_KEY` (server-only, used by the `/api/rpc` read proxy) |
| worker-1 | GCP e2-micro VM, us-central1 | `deploy/vm/setup.sh`: Node 22 + systemd, Caddy HTTPS on `sslip.io`, job store in `/var/lib/arkivate` |
| worker-2 | GCP e2-micro VM, us-east1 | Same code, its own VM, `WORKER_PRIVATE_KEY` / `WORKER_NAME` / `PUBLIC_ENDPOINT` |
| Any further worker | Any host with Node 22 | Same code, its own wallet (`pnpm worker`) |

> **No Docker.** The VMs run the worker from a clone with `tsx`; locally, just run `pnpm worker`.

Full commands, flags and env tables: [deployment.md](deployment.md). Local setup:
[run-locally.md](run-locally.md).

The worker listens on `process.env.PORT ?? WORKER_PORT` (host `HOST`), serves `GET /health`, and stores its job
data under `DATA_DIR` (default `backend/worker/data`).
