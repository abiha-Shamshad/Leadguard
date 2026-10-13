# One image, two containers (api, worker) - Section 6 deployment simplification.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
COPY packages/adapters/package.json packages/adapters/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @leadguard/api build && pnpm --filter @leadguard/worker build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml* ./
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/worker/package.json apps/worker/
COPY --from=build /app/packages packages
RUN pnpm install --frozen-lockfile --prod --filter @leadguard/api --filter @leadguard/worker
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
USER node
EXPOSE 3001
# api:    node apps/api/dist/server.js
# worker: node apps/worker/dist/main.js
CMD ["node", "apps/api/dist/server.js"]
