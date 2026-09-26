# Hermes Hub — Bun 1.4, server.ts :3456
FROM oven/bun:1.4-slim AS base
WORKDIR /app

COPY package.json ./
RUN rm -f bun.lock bun.lockb && bun install --production --no-save

COPY server.ts ./
COPY index.ts ./
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data/uploads && chown -R bun:bun /app

ENV NODE_ENV=production \
    PORT=3456 \
    HOME=/home/bun

EXPOSE 3456
USER bun
CMD ["bun", "run", "server.ts"]
