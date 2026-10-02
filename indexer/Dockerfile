# Envio HyperIndex, following enviodev/local-docker-example. NETWORK picks the committed
# config.<network>.yaml, which scripts/write-config.mjs generates from contracts/deployments/.
FROM node:24-slim
ARG NETWORK=testnet
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN npm install -g pnpm@10.34.6
WORKDIR /envio-indexer
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY config.${NETWORK}.yaml ./config.yaml
COPY schema.graphql ./
RUN pnpm envio codegen
COPY tsconfig.json ./
COPY src ./src
# Fail the build on handler type errors instead of at runtime.
RUN pnpm exec tsc --noEmit
CMD ["pnpm", "envio", "start"]
