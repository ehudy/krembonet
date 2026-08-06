# syntax=docker/dockerfile:1

# Debian trixie, not bookworm: better-sqlite3's linux prebuilds are linked
# against GLIBC_2.38, and bookworm ships 2.36 — the container built fine and
# then crash-looped on `dlopen`. Trixie has 2.41.
#
# Debian rather than Alpine for the CUPS packaging (cups-ipp-utils). The musl
# prebuilds exist too, so Alpine remains a viable swap if image size matters.
FROM node:22-trixie-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

# --ignore-scripts because better-sqlite3 carries a binding.gyp, which makes npm
# run `node-gyp rebuild` by default and demand a full Python/C++ toolchain. The
# package already ships prebuilt binaries for linux-x64, linux-arm64 and their
# musl variants, and lib/binding.js loads those when no local build exists.
#
# Safe today because no package in package-lock.json sets hasInstallScript. If
# one ever does, this flag would silently skip it — re-check when adding native
# dependencies:
#   grep '"hasInstallScript": true' package-lock.json
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY server ./server
COPY web ./web
COPY docs ./docs

# Builds the SPA into server/public, then compiles the server to server/dist.
RUN npm run build

# Drop dev dependencies from the tree we copy into the runtime stage.
RUN npm prune --omit=dev --ignore-scripts


FROM node:22-trixie-slim AS runtime

# ipptool is how the IPP adapter talks to printers. The SNMP adapter needs no
# binary — net-snmp is pure JavaScript — but the snmp CLI tools are kept for
# capturing walk fixtures by hand, which is how support for a new printer gets
# tested. ca-certificates is needed for SMTP over TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    cups-ipp-utils \
    snmp \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/krembonet.db

WORKDIR /app

# --chown on each COPY rather than a trailing `chown -R /app`: the recursive
# form rewrites every file it touches into a new layer, which duplicated all of
# node_modules and added ~88MB to the image.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/public ./server/public
# .sql files, which is why they live outside src/ where tsc would ignore them.
COPY --from=build --chown=node:node /app/server/migrations ./server/migrations

# The bind-mounted data directory must be writable by the unprivileged user.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
