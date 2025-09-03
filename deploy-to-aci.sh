#!/bin/bash

# MHTML Indexer - Azure Container Instances へのデプロイスクリプト

# 設定変数
ACR_NAME="qastregistry"  # qast-scraperとstock-scraperと同じレジストリを使用
RESOURCE_GROUP="yuyama"  # リソースグループ名
CONTAINER_NAME="mhtml-indexer"
IMAGE_NAME="mhtml-indexer"
IMAGE_TAG="latest"
LOCATION="japaneast"  # 東日本リージョン

# Log Analytics ワークスペースの設定
LOG_ANALYTICS_WORKSPACE="yuyama-batch-logs"  # Log Analytics ワークスペース名
LOG_ANALYTICS_RESOURCE_GROUP="yuyama"  # Log Analytics のリソースグループ

# ACR の完全な URL を取得
ACR_LOGIN_SERVER=$(az acr show --name $ACR_NAME --query loginServer -o tsv)

# ACR の認証情報を取得
ACR_USERNAME=$(az acr credential show --name $ACR_NAME --query username -o tsv)
ACR_PASSWORD=$(az acr credential show --name $ACR_NAME --query passwords[0].value -o tsv)

# Log Analytics ワークスペースの情報を取得
WORKSPACE_ID=$(az monitor log-analytics workspace show \
    --resource-group $LOG_ANALYTICS_RESOURCE_GROUP \
    --workspace-name $LOG_ANALYTICS_WORKSPACE \
    --query customerId -o tsv)

WORKSPACE_KEY=$(az monitor log-analytics workspace get-shared-keys \
    --resource-group $LOG_ANALYTICS_RESOURCE_GROUP \
    --workspace-name $LOG_ANALYTICS_WORKSPACE \
    --query primarySharedKey -o tsv)

# 環境変数読み込み
if [ -f ".env" ]; then
    export $(cat .env | grep -v '^#' | sed 's/#.*$//' | grep '=' | xargs)
fi

# コマンドライン引数
TARGET_SOURCE=${1:-"all"}  # デフォルトは all

echo "🚀 MHTML Indexer - Azure Container Instance デプロイ"
echo "================================================"
echo "📋 設定内容:"
echo "   リソースグループ: $RESOURCE_GROUP"
echo "   コンテナ名: $CONTAINER_NAME"
echo "   イメージ: $ACR_LOGIN_SERVER/$IMAGE_NAME:$IMAGE_TAG"
echo "   対象ソース: $TARGET_SOURCE"
echo "   リージョン: $LOCATION"
echo "================================================"

# 既存のコンテナがあれば削除
echo "🗑️  既存のコンテナを削除中..."
az container delete \
    --resource-group $RESOURCE_GROUP \
    --name $CONTAINER_NAME \
    --yes \
    2>/dev/null || true

# Container Instance を作成
echo "📦 Azure Container Instance を作成しています..."
az container create \
    --resource-group $RESOURCE_GROUP \
    --name $CONTAINER_NAME \
    --image $ACR_LOGIN_SERVER/$IMAGE_NAME:$IMAGE_TAG \
    --os-type Linux \
    --registry-login-server $ACR_LOGIN_SERVER \
    --registry-username $ACR_USERNAME \
    --registry-password $ACR_PASSWORD \
    --restart-policy Never \
    --cpu 2 \
    --memory 4 \
    --location $LOCATION \
    --log-analytics-workspace $WORKSPACE_ID \
    --log-analytics-workspace-key $WORKSPACE_KEY \
    --environment-variables \
        NODE_ENV=production \
        TARGET_SOURCE=$TARGET_SOURCE \
        CONCURRENCY=3 \
        DELAY_MS=500 \
        TIMEOUT_MS=30000 \
        MAX_RETRIES=3 \
        MAX_CONSECUTIVE_TIMEOUTS=10 \
        RAG_API_ENDPOINT="${RAG_API_ENDPOINT:-https://yuyama-rag-chatbot-api-cus.azurewebsites.net/reindex-from-blob}" \
        AZURE_STORAGE_CONNECTION_STRING="$AZURE_STORAGE_CONNECTION_STRING" \
        AZURE_STORAGE_ACCOUNT_NAME="$AZURE_STORAGE_ACCOUNT_NAME" \
        AZURE_STORAGE_ACCOUNT_KEY="$AZURE_STORAGE_ACCOUNT_KEY"

echo "✅ Container Instance のデプロイが完了しました！"
echo ""
echo "📊 コンテナ情報:"
echo "   コンテナ名: $CONTAINER_NAME"
echo "   リソースグループ: $RESOURCE_GROUP"
echo "   CPU: 2 vCPU"
echo "   メモリ: 4GB"
echo "   対象: $TARGET_SOURCE MHTMLファイル"
echo ""
echo "🔍 監視コマンド:"
echo "   状態確認: az container show --resource-group $RESOURCE_GROUP --name $CONTAINER_NAME --query instanceView.state"
echo "   ログ表示: az container logs --resource-group $RESOURCE_GROUP --name $CONTAINER_NAME --follow"
echo ""
echo "💡 使用例:"
echo "   ./deploy-to-aci.sh           # 全ソースをインデックス"
echo "   ./deploy-to-aci.sh qast      # QASTのみをインデックス"
echo "   ./deploy-to-aci.sh stock     # STOCKのみをインデックス"