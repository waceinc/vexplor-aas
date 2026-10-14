# Integrated AAS authoring, deployment and collection platform — single image
#
# Serves the API and the authoring UI from **one container, one port**. Deployments are air-gapped factory servers
# (spec Ⅷ), so it is better when carry-in, startup and checks finish in one go; being same-origin also removes CORS.
#
# Why two stages: build tools (typescript, vite, test dependencies) have no reason to stay in the runtime image.

# ── Stage 1: build ────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Copy the lock file as-is to install **exactly the same versions** (npm ci)
COPY package.json package-lock.json ./
COPY packages/aas-core/package.json  packages/aas-core/
COPY packages/aasx/package.json      packages/aasx/
COPY packages/linter/package.json    packages/linter/
COPY packages/store/package.json     packages/store/
COPY packages/collector/package.json packages/collector/
COPY packages/opcua/package.json     packages/opcua/
COPY packages/fieldbus/package.json  packages/fieldbus/
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
RUN npm ci

COPY . .
RUN npm run build && npm run --silent build --workspace @aas/web

# ── Stage 2: runtime ────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runtime dependencies only. Build tools do not come along
COPY package.json package-lock.json ./
COPY packages/aas-core/package.json  packages/aas-core/
COPY packages/aasx/package.json      packages/aasx/
COPY packages/linter/package.json    packages/linter/
COPY packages/store/package.json     packages/store/
COPY packages/collector/package.json packages/collector/
COPY packages/opcua/package.json     packages/opcua/
COPY packages/fieldbus/package.json  packages/fieldbus/
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
RUN npm ci --omit=dev --workspace @aas/api --include-workspace-root

# Take only the build output
COPY --from=build /app/packages/aas-core/dist  packages/aas-core/dist
COPY --from=build /app/packages/aasx/dist      packages/aasx/dist
COPY --from=build /app/packages/linter/dist    packages/linter/dist
COPY --from=build /app/packages/store/dist     packages/store/dist
COPY --from=build /app/packages/collector/dist packages/collector/dist
COPY --from=build /app/packages/opcua/dist     packages/opcua/dist
COPY --from=build /app/packages/fieldbus/dist  packages/fieldbus/dist
COPY --from=build /app/apps/api/dist           apps/api/dist
COPY --from=build /app/apps/web/dist           apps/web/dist

# Important: do not run as root. This process unpacks uploaded AASX files — keep privileges reduced
USER node

ENV PORT=8080
ENV WEB_ROOT=/app/apps/web/dist
EXPOSE 8080

# If it starts with authentication off, the startup log warns (apps/api/src/auth.ts)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
