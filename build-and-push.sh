#!/bin/bash

# MHTML Indexer - Container Registry イメージビルド&プッシュスクリプト

set -e

# .env読み込み
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
fi

echo "🔧 MHTML Indexer Container Registry イメージビルド&プッシュを開始"
echo "=============================================="

# 設定
REGISTRY_NAME="qastregistry"  # qast-scraperとstock-scraperと同じレジストリを使用
IMAGE_NAME="mhtml-indexer"
IMAGE_TAG="latest"

# ローカルビルド
echo "📦 TypeScriptビルド中..."
npm run build

# ACRログイン
echo "🔐 Container Registryログイン..."
az acr login --name $REGISTRY_NAME

# ACR URL取得
ACR_LOGIN_SERVER=$(az acr show --name $REGISTRY_NAME --query loginServer --output tsv)
echo "✅ Registry: $ACR_LOGIN_SERVER"

# Dockerイメージビルド（軽量Alpine版）
echo "🔨 Dockerイメージビルド中..."
docker build --platform linux/amd64 -t $IMAGE_NAME:$IMAGE_TAG .

# タグ付け
echo "🏷️ イメージタグ付け..."
docker tag $IMAGE_NAME:$IMAGE_TAG $ACR_LOGIN_SERVER/$IMAGE_NAME:$IMAGE_TAG

# プッシュ
echo "📤 Container Registryプッシュ中..."
docker push $ACR_LOGIN_SERVER/$IMAGE_NAME:$IMAGE_TAG

echo "=============================================="
echo "🎉 アップロード完了！"
echo "   イメージ: $ACR_LOGIN_SERVER/$IMAGE_NAME:$IMAGE_TAG"
echo "=============================================="