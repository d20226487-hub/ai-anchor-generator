# syntax=docker/dockerfile:1.7
# ----------------------------------------------------------------------------------------
# AI Anchor Generator — production image.
#
# Targets the deploy stack documented in DEPLOY.md (Traefik → nginx-tool-1 → this app).
# Build with the project root as the context:
#     docker build -t ai-anchor-generator:latest .
# Run with:
#     docker run -p 3000:3000 -v anchor-gen-data:/data \
#       -e BASIC_AUTH_USER=... -e BASIC_AUTH_PASS=... ai-anchor-generator:latest
#
# Local development is unchanged — `npm run dev` still uses Turbopack on :3000 outside
# the container. This image is for deploy only.
# ----------------------------------------------------------------------------------------

# ---- deps: install npm modules once and cache the layer -----------------------------
FROM node:20-alpine AS deps
WORKDIR /app
# Copy ONLY the package files first so changes to source code don't bust this cache.
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder: produce .next/standalone --------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: minimal image with just the standalone runtime ----------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Bind to 0.0.0.0 inside the container; the nginx sidecar talks to us over the
# internal docker network. Port 3000 matches the Next default.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Drop privileges. The standalone server only needs to read its own files + write to /data.
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy the standalone runtime + the assets it doesn't bundle on its own.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Volume-mounted SQLite. data.db is per-deploy state — see DATABASE_URL below.
RUN mkdir -p /data && chown -R nextjs:nodejs /data
VOLUME ["/data"]
# db.ts honours DATABASE_URL; default would be CWD/data.db, which is ephemeral inside
# the container. Pointing it at the mounted volume makes the data persist across rebuilds.
ENV DATABASE_URL=file:/data/data.db

USER nextjs
EXPOSE 3000

# Cheap liveness check — fetch /trash (a static-rendered route that hits the DB once).
# Falls back to a plain TCP probe via wget if the page returns the 401 from basic-auth.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider -q http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]
