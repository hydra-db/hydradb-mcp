# syntax=docker/dockerfile:1

# ── Build stage ────────────────────────────────────────────────────────────
# Compiles TypeScript to dist/. Needs the dev dependencies (typescript), so it
# is a separate stage that never ships.
FROM node:22-alpine AS builder

WORKDIR /app

# Install against the lockfile first, on its own layer, so a source-only change
# does not re-run the install. `--ignore-scripts` because nothing here has a
# build-time postinstall and it removes a class of supply-chain surprise.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Release stage ──────────────────────────────────────────────────────────
# Production dependencies plus the compiled output. No TypeScript, no sources.
FROM node:22-alpine AS release

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --omit=dev

COPY --from=builder /app/dist ./dist

# Bind on all interfaces INSIDE the container — the host controls exposure with
# `-p`. The default (loopback) would make the server unreachable from outside
# the container, which is never what running the image is for.
ENV BIND_ADDRESS=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# Run as the built-in unprivileged user rather than root.
USER node

# Liveness probe hits the unauthenticated health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/http.js"]
