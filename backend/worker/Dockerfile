# Built remotely by Cloud Build from the repo root (see cloudbuild.yaml); no local Docker needed.
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
ENV NODE_ENV=production DATA_DIR=/app/backend/worker/data
EXPOSE 8787
CMD ["pnpm", "start"]
