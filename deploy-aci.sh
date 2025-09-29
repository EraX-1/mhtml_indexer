#!/bin/bash

# MHTML Indexer - Azure Container Instances デプロイスクリプト

set -e

# カラー定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 MHTML Indexer ACI デプロイ開始${NC}"
echo "=============================================="

# .envファイルから環境変数を読み込み
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
else
    echo -e "${RED}❌ .envファイルが見つかりません${NC}"
    exit 1
fi

# 必須環境変数チェック
if [ -z "$AZURE_STORAGE_CONNECTION_STRING" ]; then
    echo -e "${RED}❌ AZURE_STORAGE_CONNECTION_STRINGが設定されていません${NC}"
    exit 1
fi

# 設定
RESOURCE_GROUP="yuyama"
CONTAINER_NAME="mhtml-indexer-container"
ACR_NAME="yuyamaregistry"
IMAGE_NAME="mhtml-indexer"
IMAGE_TAG="latest"

# コマンドライン引数の処理
TARGET_SOURCE=${1:-all}
DRY_RUN=${2:-false}

echo "📋 デプロイ設定:"
echo "   リソースグループ: $RESOURCE_GROUP"
echo "   コンテナ名: $CONTAINER_NAME"
echo "   対象ソース: $TARGET_SOURCE"
echo "   ドライラン: $DRY_RUN"

# リソースグループ作成（存在しない場合）
echo -e "\n${YELLOW}1️⃣ リソースグループ確認中...${NC}"
if ! az group exists --name $RESOURCE_GROUP | grep -q "true"; then
    echo "リソースグループを作成します..."
    az group create --name $RESOURCE_GROUP --location japaneast
else
    echo "✅ リソースグループは既に存在します"
fi

# ACR認証情報取得
echo -e "\n${YELLOW}2️⃣ Container Registry認証情報取得中...${NC}"
ACR_USERNAME=$(az acr credential show --name $ACR_NAME --query username -o tsv)
ACR_PASSWORD=$(az acr credential show --name $ACR_NAME --query passwords[0].value -o tsv)
ACR_LOGIN_SERVER=$(az acr show --name $ACR_NAME --query loginServer -o tsv)

echo "✅ ACR: $ACR_LOGIN_SERVER"

# 既存のコンテナインスタンス削除（存在する場合）
echo -e "\n${YELLOW}3️⃣ 既存コンテナ確認中...${NC}"
if az container show --name $CONTAINER_NAME --resource-group $RESOURCE_GROUP &>/dev/null; then
    echo "既存のコンテナを削除します..."
    az container delete --name $CONTAINER_NAME --resource-group $RESOURCE_GROUP --yes
    echo "✅ 削除完了"
else
    echo "既存のコンテナはありません"
fi

# ACIデプロイ
echo -e "\n${YELLOW}4️⃣ コンテナインスタンスデプロイ中...${NC}"

# Storage Accountのキーを動的に取得
STORAGE_ACCOUNT="yuyamablobstorage"
STORAGE_KEY=$(az storage account keys list --resource-group $RESOURCE_GROUP --account-name $STORAGE_ACCOUNT --query '[0].value' --output tsv)
AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=$STORAGE_ACCOUNT;AccountKey=$STORAGE_KEY;EndpointSuffix=core.windows.net"

# 環境変数の設定
ENV_VARS="AZURE_STORAGE_CONNECTION_STRING=$AZURE_STORAGE_CONNECTION_STRING "
ENV_VARS+="RAG_API_ENDPOINT=$RAG_API_ENDPOINT "
ENV_VARS+="RAG_API_KEY=$RAG_API_KEY "
ENV_VARS+="TARGET_SOURCE=$TARGET_SOURCE "
ENV_VARS+="CONCURRENCY=10 "
ENV_VARS+="DELAY_MS=500 "
ENV_VARS+="TIMEOUT_MS=60000 "
ENV_VARS+="MAX_RETRIES=0 "
ENV_VARS+="MAX_CONSECUTIVE_TIMEOUTS=10 "
ENV_VARS+="DRY_RUN=$DRY_RUN "

# Log Analytics ワークスペース情報取得
echo -e "\n${YELLOW}Log Analytics ワークスペース設定中...${NC}"
LOG_ANALYTICS_WORKSPACE="yuyama-batch-logs"
LOG_ANALYTICS_WORKSPACE_ID=$(az monitor log-analytics workspace show \
    --resource-group $RESOURCE_GROUP \
    --workspace-name $LOG_ANALYTICS_WORKSPACE \
    --query customerId -o tsv 2>/dev/null)

if [ -z "$LOG_ANALYTICS_WORKSPACE_ID" ]; then
    echo -e "${RED}❌ Log Analytics ワークスペース '$LOG_ANALYTICS_WORKSPACE' が見つかりません${NC}"
    echo "Log Analytics なしでデプロイを続行します..."
    
    # デプロイコマンド実行（Log Analytics なし）
    az container create \
        --resource-group $RESOURCE_GROUP \
        --name $CONTAINER_NAME \
        --image $ACR_LOGIN_SERVER/$IMAGE_NAME:$IMAGE_TAG \
        --registry-username $ACR_USERNAME \
        --registry-password "$ACR_PASSWORD" \
        --cpu 1 \
        --memory 2 \
        --os-type Linux \
        --restart-policy OnFailure \
        --environment-variables $ENV_VARS
else
    LOG_ANALYTICS_WORKSPACE_KEY=$(az monitor log-analytics workspace get-shared-keys \
        --resource-group $RESOURCE_GROUP \
        --workspace-name $LOG_ANALYTICS_WORKSPACE \
        --query primarySharedKey -o tsv)
    
    echo "✅ Log Analytics ワークスペース: $LOG_ANALYTICS_WORKSPACE"
    
    # デプロイコマンド実行（Log Analytics あり）
    az container create \
        --resource-group $RESOURCE_GROUP \
        --name $CONTAINER_NAME \
        --image $ACR_LOGIN_SERVER/$IMAGE_NAME:$IMAGE_TAG \
        --registry-username $ACR_USERNAME \
        --registry-password "$ACR_PASSWORD" \
        --cpu 1 \
        --memory 2 \
        --os-type Linux \
        --restart-policy OnFailure \
        --environment-variables $ENV_VARS \
        --log-analytics-workspace $LOG_ANALYTICS_WORKSPACE_ID \
        --log-analytics-workspace-key "$LOG_ANALYTICS_WORKSPACE_KEY"
fi

echo -e "\n${GREEN}✅ デプロイ完了！${NC}"

# ログ確認方法を表示
echo -e "\n${YELLOW}📝 ログ確認方法:${NC}"
echo "az container logs --name $CONTAINER_NAME --resource-group $RESOURCE_GROUP --follow"

echo -e "\n${YELLOW}📊 ステータス確認:${NC}"
echo "az container show --name $CONTAINER_NAME --resource-group $RESOURCE_GROUP --query instanceView.state"

# 初期ログを表示
echo -e "\n${YELLOW}📋 初期ログ:${NC}"
sleep 5
az container logs --name $CONTAINER_NAME --resource-group $RESOURCE_GROUP || echo "ログはまだ利用できません"