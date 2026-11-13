# ---------- Stage 1: base ----------
FROM node:22-alpine AS base
WORKDIR /app
COPY app/package.json ./
COPY app/src ./src
COPY app/public ./public

# ---------- Stage 2: test (Jenkins runs: docker build --target test) ----------
FROM base AS test
COPY app/test ./test
RUN node --test test/*.test.js

# ---------- Stage 3: runtime (the image deployed to Kubernetes) ----------
FROM base AS runtime
ENV NODE_ENV=production PORT=3000
# run as the unprivileged "node" user, never as root
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "src/server.js"]
