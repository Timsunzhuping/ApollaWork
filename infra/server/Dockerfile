# Apolla Work server 镜像（生产）。多阶段构建：pnpm 装依赖 + 编译 → 精简运行时。
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/runtime ./apps/runtime
COPY skills ./skills
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @apolla/protocol --filter @apolla/agent-tools run build \
    && pnpm --filter @apolla/runtime run build \
    && pnpm --filter @apolla/server run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/server
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy || npx prisma db push --skip-generate; node dist/main.js"]
