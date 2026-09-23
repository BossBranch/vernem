# syntax=docker/dockerfile:1
# Сборка: TypeScript → JS. Нативных модулей нет (SQLite встроен в Node), поэтому сборка быстрая.
FROM node:22.23.2-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.2-alpine3.24 AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/vernem.db \
    NODE_EXTRA_CA_CERTS=/app/assets/certs/russian_trusted_root_ca.pem
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY norms ./norms
COPY assets ./assets
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/index.js"]
