# ---------- Stage 1: source ----------
FROM node:22-alpine AS base
WORKDIR /app
COPY app/package.json ./
COPY app/src ./src
COPY app/public ./public

# ---------- Stage 2: tests (functional + security tests) ----------
FROM base AS test
COPY app/test ./test
RUN node --test test/*.test.js

# ---------- Stage 3: hardened runtime image ----------
FROM node:22-alpine AS runtime
# - patch OS packages to pick up security fixes
# - remove npm / npx / yarn / corepack: not needed at runtime and a frequent source of CVEs
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
# app files are owned by root and read-only for the app user (code cannot be modified at runtime)
COPY --from=base --chown=root:root /app /app
ENV NODE_ENV=production PORT=3000
# unprivileged numeric user (Kubernetes can verify runAsNonRoot)
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "src/server.js"]
