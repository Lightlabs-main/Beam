# Envio HyperIndex, following enviodev/local-docker-example. Uses the committed config.yaml,
# which scripts/write-config.mjs generates from contracts/deployments/.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN npm install -g pnpm@10.34.6
WORKDIR /envio-indexer
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY config.yaml schema.graphql ./
RUN pnpm envio codegen
COPY src ./src
CMD ["pnpm", "envio", "start"]
