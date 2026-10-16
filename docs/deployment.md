# Deployment

Three deployables from one repo: the web app, and the two reference workers (worker-1, worker-2).
The reference workers are not special. Any operator can deploy more workers the same way, or on any
other host that runs Node 22; see [Add your own worker](#add-your-own-worker).

| What | Where | Status |
|---|---|---|
| Web app (`frontend/`) | Vercel | TODO: live URL |
| worker-1 | Google Cloud Run, region TODO | TODO: `https://…/health` |
| worker-2 | Google Cloud Run, a different region TODO | TODO: `https://…/health` |

Each worker has its own wallet (see [`WALLETS.md`](../WALLETS.md)), its own job store and its own
secrets. They share nothing but Arkiv.

## Web app (Vercel)

1. Import the GitHub repo in Vercel. **Root Directory:** `frontend`. Framework: Next.js (detected).
   The build uses webpack, not Turbopack (`arkiv/friction.md` F18); `next.config.ts` already sets it up.
2. Environment variables:

   | Variable | Required? | Purpose |
   |---|---|---|
   | `ARKIV_ACCESS_KEY` | Recommended | Server-only. The `/api/rpc` read proxy adds it as `X-API-KEY`; without it, reads share the keyless limit (~100 queries/hour/IP). Never exposed to the browser. |
   | `ARKIV_RPC_HTTP` | No | Defaults to the Tiramisu RPC. |

3. Deploy. The site holds no private keys: visitors sign writes in their own wallet (MetaMask), and
   the proxy forwards only read methods.

## Workers (Google Cloud Run)

No local Docker: Cloud Build builds the image from `backend/worker/Dockerfile`, with the repo root as
the build context.

One-time setup (replace `PROJECT_ID` and `REGION`):

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud artifacts repositories create arkivate --repository-format=docker --location=REGION
```

Build once; every worker runs the same image:

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions _IMAGE=REGION-docker.pkg.dev/PROJECT_ID/arkivate/worker:latest .
```

Per worker (shown for worker-1; repeat with `worker-2`, its own key, bucket and a different region):

```bash
# secrets: the worker's own key, and the shared Arkiv access key
printf '%s' "$WORKER_1_KEY" | gcloud secrets create worker-1-key --data-file=-
printf '%s' "$ARKIV_ACCESS_KEY" | gcloud secrets create arkiv-access-key --data-file=-   # once

# persistent job store (fired epochs, expiry index, pinned deadlines, sealed jobs)
gcloud storage buckets create gs://PROJECT_ID-arkivate-worker-1 --location=REGION

gcloud run deploy arkivate-worker-1 \
  --image REGION-docker.pkg.dev/PROJECT_ID/arkivate/worker:latest \
  --region REGION \
  --min-instances=1 --max-instances=1 --no-cpu-throttling \
  --allow-unauthenticated \
  --add-volume name=data,type=cloud-storage,bucket=PROJECT_ID-arkivate-worker-1 \
  --add-volume-mount volume=data,mount-path=/app/backend/worker/data \
  --set-env-vars WORKER_NAME=worker-1,TRIGGER_CREATORS=TODO,CORS_ORIGINS=TODO \
  --set-secrets WORKER_PRIVATE_KEY=worker-1-key:latest,ARKIV_ACCESS_KEY=arkiv-access-key:latest
```

Then set `PUBLIC_ENDPOINT` to the service URL Cloud Run printed, and redeploy so the worker
re-registers with it:

```bash
gcloud run services update arkivate-worker-1 --region REGION \
  --update-env-vars PUBLIC_ENDPOINT=https://arkivate-worker-1-….run.app
```

On start the worker validates its config, checks the chain ID, and patches its existing `worker`
entity with the new endpoint (it finds it by `$creator`, so a redeploy never creates a second
registration). `GET /health` should then report `"mode": "live"`.

Why each flag:

| Flag | Reason |
|---|---|
| `--min-instances=1` | A worker must never scale to zero: it holds a WebSocket subscription and pollers. |
| `--no-cpu-throttling` | CPU stays on between HTTP requests, so the 10 s expiry sweep and 30 s pollers keep running. |
| `--max-instances=1` | One container per wallet. Two containers with one key would race on nonces (`predictEntityKeys` is nonce-derived) and could double-fire. |
| GCS volume | The job store survives restarts: expiries that happen while the worker is down are still caught, and pinned deadlines never move. |
| `--allow-unauthenticated` | `POST /sealed` (the hand-off) and `GET /health` must be publicly reachable. The hand-off authenticates by signature, not by IAM. |
| `--set-secrets` | Private keys live in Secret Manager, never in plain env flags or the image. |

### Worker environment

| Variable | Required? | Default | Purpose |
|---|---|---|---|
| `WORKER_PRIVATE_KEY` | **Yes** | | The worker's own wallet. `0x` + 64 hex. Must hold testnet GLM, or the worker stays in read-only dry-run mode. |
| `WORKER_NAME` | Recommended | `worker-local` | Name in the `worker` entity, and the job-store file name. |
| `ARKIV_ACCESS_KEY` | Recommended | | Sent as `X-API-KEY`. A worker polls constantly; the keyless limit is ~100 queries/hour/IP. |
| `PUBLIC_ENDPOINT` | For sealed jobs | | Public URL published in the `worker` entity so owners can hand off sealed jobs. |
| `PORT` / `WORKER_PORT` | No | `8787` | Cloud Run sets `PORT`, which wins. |
| `DATA_DIR` | No | `backend/worker/data` | Job store location. The Dockerfile sets `/app/backend/worker/data`. |
| `ARKIV_RPC_HTTP` / `ARKIV_RPC_WS` | No | Tiramisu | RPC endpoints. |
| `TRIGGER_CREATORS` | No | empty = any | Comma-separated addresses whose **public** triggers this worker runs (gas guard). |
| `MAX_RECEIPTS_PER_TRIGGER_PER_HOUR` | No | `12` | Gas guard: receipts per trigger per hour from this worker. |
| `CORS_ORIGINS` | No | `*` | Browser origins allowed to `POST /sealed` (set it to the web app's origin). |
| `TELEGRAM_BOT_TOKEN` | For Telegram delivery | | Bot used to deliver sealed alerts. Without it, Telegram jobs fail delivery and write no receipt. |
| `SKIP_SEALED` | No | `false` | **Demo switch only.** Accepts sealed jobs but never fires them, to stage a provable skip. Never enable on a worker people should trust. |

### Gas guards on the reference workers

Every receipt costs the worker gas (measured ~0.00014 GLM each at 1 gwei), and anyone can post a
public trigger. The reference workers therefore run with `TRIGGER_CREATORS` set (TODO: final list),
so they only run public triggers from listed creators. Two consequences, stated plainly:

- A public trigger created by someone else will not fire on the reference workers. It will fire on
  any worker that accepts all creators, including one you run yourself.
- `TRIGGER_CREATORS` does not apply to sealed hand-offs today; the per-trigger hourly cap does.

Owner-funded triggers (the owner pays for its own receipts) are on the roadmap and would remove the
need for an allowlist.

## Add your own worker

Any operator can join the network. A worker needs a funded wallet, ideally an Arkiv access key, and
a host that keeps a process running.

```bash
git clone https://github.com/NatX223/Arkivate.git && cd Arkivate
corepack enable && pnpm install
pnpm wallets                 # prints fresh keys + addresses; writes nothing
cp .env.example .env         # set WORKER_NAME, WORKER_PRIVATE_KEY, ARKIV_ACCESS_KEY
# fund the worker address at https://hub.arkiv.network/faucet
pnpm worker
```

The worker registers a `worker` entity signed by its wallet, extends it every 6 hours, and drops out
of the network when it stops (the entity expires after 1 day). It ranks itself among live workers by
address for dedupe (see the README). To accept sealed hand-offs, give it a public URL and set
`PUBLIC_ENDPOINT`. On Cloud Run, reuse the commands above with your own project.

The worker package is not published to npm yet, so there is no `npx` one-liner; it runs from a
clone with `pnpm worker` (TypeScript via `tsx`, no build step).

## Smoke test after deploying

1. `curl https://<worker>/health` on each worker: `ok: true`, `mode: "live"`, the expected
   `address`, `triggers > 0`.
2. The web app's Workers page lists both workers with their health.
3. `pnpm cli demo-feed --kind listing --blocks 120` and watch a keep-alive trigger extend it
   (receipt with `outcome = extended` on the trigger page).
4. Sealed path: `pnpm cli seal --spec backend/cli/examples/sealed-event-webhook.json --worker worker-1 --webhook <your test URL>`,
   then `pnpm cli demo-feed --kind event --ttl 1440`, then `pnpm cli verify <sealed-key>` after a
   `reveal`. Use a long `--ttl` so the evidence outlives judging (see `docs/verification.md`).
