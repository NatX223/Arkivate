# OPTIONAL: container image for hosts that want one. The reference workers don't use it; they run
# as plain Node on VMs (deploy/vm/, docs/deploy-vm.md). Build from the repo root, e.g. with
# cloudbuild.yaml. HOST=0.0.0.0 because NODE_ENV=production otherwise binds 127.0.0.1.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY backend/core/package.json backend/core/
COPY backend/worker/package.json backend/worker/
RUN pnpm install --frozen-lockfile --filter @arkivate/worker...
COPY backend/core backend/core
COPY backend/worker backend/worker
WORKDIR /app/backend/worker
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/app/backend/worker/data
EXPOSE 8787
CMD ["pnpm", "start"]
