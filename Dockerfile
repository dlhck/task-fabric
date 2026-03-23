FROM oven/bun:1.3 AS base

RUN apt-get update && \
    apt-get install -y git python3 make g++ curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ src/
COPY index.ts tsconfig.json ./

ENV PORT=8181
EXPOSE 8181

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -f http://localhost:8181/health || exit 1

CMD ["bun", "run", "src/server.ts"]
