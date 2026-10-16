# Arkivate — Repo Structure & Deployment

## Layout

pnpm monorepo: one repo, one lockfile, three separate deployments (frontend, worker A, worker B).

```
Arkivate/                     ← root: shared config only
├─ package.json               # root scripts + dev tools
├─ pnpm-workspace.yaml        # backend/*, frontend
├─ tsconfig.base.json
├─ cloudbuild.yaml            # remote image build for the worker
├─ .env.example               # local .env is gitignored
├─ .dockerignore
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
│  ├─ worker/                 # DEPLOYED ×2
│  │  ├─ Dockerfile
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
| Frontend | Vercel | Root Directory = `frontend` |
| Worker A | GCP Cloud Run | `cloudbuild.yaml` + `backend/worker/Dockerfile` (cloud build), GCS volume for `data/` |
| Worker B | GCP Cloud Run (other region) or another provider | Same image, different `WORKER_PRIVATE_KEY` / `WORKER_NAME` / `PUBLIC_ENDPOINT` |

> **No local Docker.** Cloud Build builds the image remotely. Locally, just run `pnpm worker`.

## GCP Cloud Run

One-time setup:
```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud artifacts repositories create arkivate --repository-format=docker --location=REGION
gcloud storage buckets create gs://PROJECT_ID-arkivate-worker-a --location=REGION
```

Build (runs in the cloud) and deploy:
```bash
gcloud builds submit --config cloudbuild.yaml .

gcloud run deploy arkivate-worker-a \
  --image REGION-docker.pkg.dev/PROJECT_ID/arkivate/worker:latest \
  --region REGION \
  --min-instances=1 --max-instances=1 \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --add-volume name=data,type=cloud-storage,bucket=PROJECT_ID-arkivate-worker-a \
  --add-volume-mount volume=data,mount-path=/app/backend/worker/data \
  --set-env-vars WORKER_NAME=worker-a,ARKIV_RPC_HTTP=...,ARKIV_RPC_WS=...,PUBLIC_ENDPOINT=https://<service-url> \
  --set-secrets WORKER_PRIVATE_KEY=worker-a-key:latest,ARKIV_ACCESS_KEY=arkiv-access-key:latest
```

Why each flag matters:
- `--min-instances=1`: the worker must never scale to zero.
- `--no-cpu-throttling`: CPU stays on between requests, so the WebSocket listener and pollers keep running.
- `--max-instances=1`: one container per worker identity, so it can't double-fire.
- GCS volume: the job store survives restarts.
- `--allow-unauthenticated`: the `/sealed` hand-off and `/health` must be publicly reachable.
- `--set-secrets`: private keys go in Secret Manager, never in plain env flags.

Worker B: repeat with `arkivate-worker-b`, its own bucket and secret, ideally in a different region.

The worker listens on `process.env.PORT ?? WORKER_PORT`, serves `GET /health`, and stores its job
data under `DATA_DIR` (default `backend/worker/data`).
