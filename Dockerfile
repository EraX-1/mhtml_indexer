# MHTML Indexer Container for Azure Container Instances
FROM node:20-alpine AS builder

WORKDIR /app

# package.jsonとpackage-lock.json（あれば）をコピー
COPY package*.json ./

# 依存関係をインストール
RUN npm ci && \
    npm install --save-dev typescript @types/node ts-node

# ソースコードをコピー
COPY tsconfig.json ./
COPY src ./src

# TypeScriptをビルド
RUN npm run build

# 実行用の軽量イメージ
FROM node:20-alpine

WORKDIR /app

# 本番用の依存関係のみインストール
COPY package*.json ./
RUN npm ci --only=production

# ビルドされたアプリケーションをコピー
COPY --from=builder /app/dist ./dist

# 環境変数のデフォルト値
ENV NODE_ENV=production
ENV TARGET_SOURCE=all
ENV CONCURRENCY=3
ENV DELAY_MS=500
ENV TIMEOUT_MS=30000
ENV MAX_RETRIES=3
ENV MAX_CONSECUTIVE_TIMEOUTS=10

# 非rootユーザーで実行
USER node

# アプリケーションを起動
CMD ["node", "dist/index.js"]