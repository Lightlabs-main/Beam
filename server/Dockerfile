# Beam server: gasless relayer, indexed gift feed (WebSocket) and the web pages.
# Build context is the repository root (pnpm workspace + contracts/deployments).
FROM node:24-slim
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN npm install -g pnpm@10.34.6
WORKDIR /beam
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY contracts/deployments contracts/deployments
COPY packages/shared packages/shared
COPY server server
COPY web web
RUN pnpm --filter @beam/web build
ENV WEB_DIR=/beam/web/dist NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "--filter", "@beam/server", "start"]
