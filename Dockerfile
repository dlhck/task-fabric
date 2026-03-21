FROM oven/bun:1.3 AS base

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ src/
COPY index.ts tsconfig.json ./

ENV PORT=8181
EXPOSE 8181

CMD ["bun", "run", "src/server.ts"]
