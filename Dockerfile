FROM oven/bun:1.3 AS base

RUN apt-get update && \
    apt-get install -y git python3 make g++ && \
    rm -rf /var/lib/apt/lists/* && \
    git config --global user.email "task-fabric@localhost" && \
    git config --global user.name "TaskFabric"

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ src/
COPY index.ts tsconfig.json ./

ENV PORT=8181
EXPOSE 8181

CMD ["bun", "run", "src/server.ts"]
