# syntax=docker/dockerfile:1

# ---- build: compile shared, API and the PWA -------------------------------
FROM node:22-slim AS build
WORKDIR /app

ENV CI=true
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY apps ./apps
COPY packages ./packages
COPY db ./db
COPY scripts ./scripts

RUN npm run build

# ---- runtime: production dependencies + compiled artifacts only -----------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    RUN_MIGRATIONS_ON_START=false

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/assets ./apps/api/assets
COPY --from=build /app/db ./db

EXPOSE 3000

# The API serves the SPA and exposes /v1. Migrations are normally applied by
# the one-shot `seed` service before this container starts; startup migration
# remains available through RUN_MIGRATIONS_ON_START=true.
CMD ["node", "apps/api/dist/main.js"]
