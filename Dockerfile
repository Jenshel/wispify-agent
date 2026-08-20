# syntax=docker/dockerfile:1
# Dockerfile — multi-stage build for wispify-agent.
#
# Stage 1 builds the admin panel (Vite/React, panel/dist). Stage 2 installs
# backend production dependencies (better-sqlite3 needs a native build
# toolchain that the final image should NOT ship). Stage 3 is the slim
# runtime image: just the backend source, its node_modules, and the built
# panel — served together by src/app.js via express.static() when
# panel/dist exists (see src/app.js).
#
# Build:  docker build -t wispify-agent .
# Run:    docker run --env-file .env -p 3000:3000 -v wispify-data:/app/data wispify-agent
# (or use docker-compose.yml, which wires the same volume + env file)

# Node 22, not 20: better-sqlite3@13.x's OWN package.json requires
# node >=22 (confirmed via node_modules/better-sqlite3/package.json) even
# though this repo's root package.json still declares ">=20" — a
# pre-existing mismatch this Dockerfile deliberately does not paper over by
# using an unsupported base image; see PR body for the flagged discrepancy.

# ---- Stage 1: build the admin panel ----------------------------------------
FROM node:22-alpine AS panel-build
WORKDIR /app/panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci
COPY panel/ ./
RUN npm run build

# ---- Stage 2: install backend production dependencies -----------------------
# better-sqlite3 compiles a native addon at install time — python3/make/g++
# only need to exist in THIS stage, never in the final runtime image.
FROM node:22-alpine AS backend-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 3: slim runtime image --------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=panel-build /app/panel/dist ./panel/dist

# data/ holds the SQLite DB and the auto-generated CONFIG_ENCRYPTION_KEY
# keyfile (src/config/secrets.js) — must persist across restarts, mount a
# volume at /app/data (see docker-compose.yml). Created + owned by the
# non-root `node` user (built into the official Node image, uid 1000) before
# dropping root, so the app can write to it without a privileged init step.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE $PORT
CMD ["node", "src/server.js"]
