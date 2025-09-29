import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

export interface IndexRequest {
  id: string;
  source: 'qast' | 'stock';
  fileName: string;
  content: string;
  metadata?: {
    size?: number;
    lastModified?: Date;
    contentType?: string;
    [key: string]: any;
  };
}

export interface IndexResponse {
  success: boolean;
  id: string;
  message?: string;
  error?: string;
}

export class RagIndexer {
  private client: AxiosInstance;
  private apiEndpoint: string;
  
  constructor() {
    this.apiEndpoint = process.env.RAG_API_ENDPOINT || '';
    
    if (!this.apiEndpoint) {
      throw new Error('RAG_API_ENDPOINT環境変数が設定されていません');
    }
    
    // Axiosクライアントの設定
    this.client = axios.create({
      baseURL: this.apiEndpoint,
      timeout: 60000, // 60秒タイムアウト
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    // リクエストインターセプター
    this.client.interceptors.request.use(
      (config) => {
        console.log(`🌐 RAG API リクエスト: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        console.error('❌ リクエストエラー:', error);
        return Promise.reject(error);
      }
    );
    
    // レスポンスインターセプター
    this.client.interceptors.response.use(
      (response) => {
        console.log(`✅ RAG API レスポンス: ${response.status}`);
        return response;
      },
      (error) => {
        if (error.response) {
          console.error(`❌ APIエラー: ${error.response.status} - ${error.response.statusText}`);
          console.error('エラーデータ:', error.response.data);
        } else if (error.request) {
          console.error('❌ ネットワークエラー: レスポンスが受信されませんでした');
        } else {
          console.error('❌ エラー:', error.message);
        }
        return Promise.reject(error);
      }
    );
  }
  
  /**
   * 単一のドキュメントをインデックス
   */
  async indexDocument(request: IndexRequest): Promise<IndexResponse> {
    try {
      const startTime = Date.now();
      console.log(`📤 インデックス送信中: ${request.id} (${request.source}/${request.fileName})`);
      
      const response = await this.client.post('/index', {
        id: request.id,
        source: request.source,
        fileName: request.fileName,
        content: request.content,
        metadata: {
          ...request.metadata,
          indexedAt: new Date().toISOString()
        }
      });
      
      const duration = Date.now() - startTime;
      console.log(`✅ インデックス成功: ${request.id} (${duration}ms)`);
      
      return {
        success: true,
        id: request.id,
        message: response.data.message || 'インデックスが成功しました'
      };
    } catch (error) {
      const errorMessage = axios.isAxiosError(error) 
        ? error.response?.data?.error || error.message 
        : 'Unknown error';
      
      console.error(`❌ インデックス失敗: ${request.id} - ${errorMessage}`);
      
      return {
        success: false,
        id: request.id,
        error: errorMessage
      };
    }
  }
  
  /**
   * 複数のドキュメントをバッチでインデックス
   */
  async batchIndexDocuments(
    requests: IndexRequest[],
    options: {
      batchSize?: number;
      delayMs?: number;
      maxRetries?: number;
    } = {}
  ): Promise<{
    success: number;
    failed: number;
    results: IndexResponse[];
  }> {
    const { 
      batchSize = 10, 
      delayMs = 1000
    } = options;
    
    console.log(`📦 バッチインデックス開始: ${requests.length}件のドキュメント`);
    console.log(`⚙️  設定: バッチサイズ=${batchSize}, 遅延=${delayMs}ms`);
    
    const results: IndexResponse[] = [];
    let successCount = 0;
    let failedCount = 0;
    
    // バッチ処理
    for (let i = 0; i < requests.length; i += batchSize) {
      const batch = requests.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(requests.length / batchSize);
      
      console.log(`\n📦 バッチ ${batchNumber}/${totalBatches}: ${batch.length}件処理中...`);
      
      // バッチ内の各リクエストを順次処理（1件ずつ）
      const batchResults: IndexResponse[] = [];
      
      for (const request of batch) {
        const result = await this.indexDocument(request);
        batchResults.push(result);
      }
      
      // 結果を集計
      batchResults.forEach(result => {
        results.push(result);
        if (result.success) {
          successCount++;
        } else {
          failedCount++;
        }
      });
      
      // バッチ間の遅延
      if (i + batchSize < requests.length) {
        console.log(`⏳ 次のバッチまで${delayMs}ms待機中...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    console.log(`\n📊 バッチインデックス完了:`);
    console.log(`   ✅ 成功: ${successCount}件`);
    console.log(`   ❌ 失敗: ${failedCount}件`);
    
    return {
      success: successCount,
      failed: failedCount,
      results
    };
  }
  
  /**
   * ヘルスチェック
   */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      const response = await this.client.get('/health');
      return {
        healthy: true,
        message: response.data.message || 'API is healthy'
      };
    } catch (error) {
      return {
        healthy: false,
        message: axios.isAxiosError(error) ? error.message : 'Health check failed'
      };
    }
  }
}