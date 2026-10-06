# One image per service: docker build -f infrastructure/docker/service.Dockerfile --build-arg SERVICE=<name> .
# The same image runs the API (default) or the worker (`node dist/worker.js`).

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
ARG SERVICE
RUN test -n "$SERVICE" || (echo "SERVICE build arg is required" && exit 1)
RUN corepack enable
WORKDIR /repo
COPY . .
# The lockfile is authoritative in image builds.
RUN pnpm install --frozen-lockfile --filter "@aegis/${SERVICE}..." \
 && pnpm --filter "@aegis/${SERVICE}..." run --if-present prisma:generate \
 && pnpm --filter "@aegis/${SERVICE}..." run build \
 && pnpm deploy --legacy --filter "@aegis/${SERVICE}" --prod /out \
 && cp -r "services/${SERVICE}/dist" /out/dist \
 && (cp -r "services/${SERVICE}/prisma" /out/prisma 2>/dev/null || true) \
 && (cp "services/${SERVICE}/prisma.config.ts" /out/ 2>/dev/null || true)

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
# Non-root, no shell tooling needed at runtime; compose and ECS run with a read-only root filesystem.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health/live" || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
