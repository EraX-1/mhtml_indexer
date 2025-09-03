import { BlobServiceClient } from '@azure/storage-blob';
import FormData from 'form-data';
import fetch from 'node-fetch';
import * as dotenv from 'dotenv';

dotenv.config();

export interface IndexingResult {
  success: boolean;
  blobName: string;
  source: 'qast' | 'stock';
  error?: string;
  statusCode?: number;
}

export class MhtmlBlobIndexer {
  private blobServiceClient: BlobServiceClient;
  private indexEndpoint: string;
  private consecutiveTimeouts: number = 0;
  private readonly MAX_CONSECUTIVE_TIMEOUTS: number;
  
  constructor(
    indexEndpoint: string = process.env.RAG_API_ENDPOINT || 'https://yuyama-rag-chatbot-api-cus.azurewebsites.net/reindex-from-blob'
  ) {
    // Azure Storage接続設定
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    
    if (connectionString) {
      this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else if (accountName && accountKey) {
      const credential = { accountName, accountKey };
      this.blobServiceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential as any
      );
    } else {
      throw new Error('Azure Storage接続情報が不足しています');
    }
    
    this.indexEndpoint = indexEndpoint;
    this.MAX_CONSECUTIVE_TIMEOUTS = parseInt(process.env.MAX_CONSECUTIVE_TIMEOUTS || '10');
  }

  /**
   * Blobから単一MHTMLファイルをダウンロード
   */
  async downloadBlob(containerName: string, blobName: string): Promise<Buffer> {
    try {
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      const downloadResponse = await blockBlobClient.download();
      
      if (!downloadResponse.readableStreamBody) {
        throw new Error('ダウンロードストリームが取得できません');
      }

      const chunks: Buffer[] = [];
      for await (const chunk of downloadResponse.readableStreamBody) {
        chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
      }
      
      return Buffer.concat(chunks);
    } catch (error) {
      throw new Error(`Blobダウンロードエラー (${blobName}): ${error}`);
    }
  }

  /**
   * MHTMLファイルを/reindex-from-blobエンドポイントに送信（タイムアウト・リトライ付き）
   */
  async indexMhtmlFile(
    containerName: string, 
    blobName: string, 
    fileBuffer: Buffer, 
    indexType: 'qast' | 'stock',
    sourceUrl?: string, 
    timeoutMs: number = parseInt(process.env.TIMEOUT_MS || '30000'), 
    maxRetries: number = parseInt(process.env.MAX_RETRIES || '3')
  ): Promise<IndexingResult> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`📤 インデックス送信開始: ${blobName} [${indexType}] (試行 ${attempt}/${maxRetries})`);
        
        // Blob URLを生成
        const blobUrl = this.generateBlobUrl(containerName, blobName);
        
        // FormDataを作成
        const formData = new FormData();
        formData.append('file', fileBuffer, {
          filename: blobName,
          contentType: 'application/octet-stream'
        });
        formData.append('index_type', indexType);
        formData.append('blob_url', blobUrl);
        
        if (sourceUrl) {
          formData.append('source_url', sourceUrl);
        }

        // デバッグ情報を表示（初回のみ）
        if (attempt === 1) {
          console.log(`🔍 送信データ詳細: ${blobName}`);
          console.log(`   ├─ エンドポイント: ${this.indexEndpoint}`);
          console.log(`   ├─ index_type: ${indexType}`);
          console.log(`   ├─ blob_url: ${blobUrl}`);
          console.log(`   ├─ source_url: ${sourceUrl || 'なし'}`);
          console.log(`   ├─ ファイルサイズ: ${Math.round(fileBuffer.length / 1024)}KB`);
          console.log(`   └─ タイムアウト: ${timeoutMs}ms`);
        }

        const startTime = Date.now();
        
        // タイムアウト機能付きFetch
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          console.log(`⏰ タイムアウト発生: ${blobName} (${timeoutMs}ms) - 試行 ${attempt}/${maxRetries}`);
          controller.abort();
        }, timeoutMs);
        
        try {
          // APIに送信
          const response = await fetch(this.indexEndpoint, {
            method: 'POST',
            body: formData,
            headers: {
              ...formData.getHeaders()
            },
            signal: controller.signal
          });

          clearTimeout(timeoutId);
          const duration = Date.now() - startTime;
          console.log(`⏱️ API応答時間: ${duration}ms`);

          if (response.ok) {
            let responseData;
            try {
              const responseText = await response.text();
              console.log(`📄 レスポンスボディ: ${responseText}`);
              
              try {
                responseData = JSON.parse(responseText);
                console.log(`📊 パース済みレスポンス:`, JSON.stringify(responseData, null, 2));
              } catch {
                responseData = responseText;
              }
            } catch (error) {
              console.log(`⚠️ レスポンス読み取りエラー: ${error}`);
            }

            console.log(`✅ インデックス送信成功: ${blobName} [${indexType}] (${response.status}) - ${duration}ms`);
            this.consecutiveTimeouts = 0;
            return {
              success: true,
              blobName,
              source: indexType,
              statusCode: response.status
            };
          } else {
            let errorText;
            try {
              errorText = await response.text();
              console.log(`📄 エラーレスポンスボディ: ${errorText}`);
            } catch (error) {
              errorText = `レスポンス読み取り失敗: ${error}`;
            }

            console.log(`❌ インデックス送信失敗: ${blobName} [${indexType}] (${response.status}) - ${duration}ms: ${errorText}`);
            
            return {
              success: false,
              blobName,
              source: indexType,
              statusCode: response.status,
              error: `HTTP ${response.status}: ${errorText}`
            };
          }
        } catch (fetchError) {
          clearTimeout(timeoutId);
          
          if (fetchError instanceof Error && fetchError.name === 'AbortError') {
            this.consecutiveTimeouts++;
            console.log(`⏰ タイムアウト発生 (連続${this.consecutiveTimeouts}回): ${blobName} - 試行 ${attempt}/${maxRetries}`);
            
            if (this.consecutiveTimeouts >= this.MAX_CONSECUTIVE_TIMEOUTS) {
              console.error(`🚨 連続タイムアウト上限到達 (${this.MAX_CONSECUTIVE_TIMEOUTS}回) - 処理を強制終了します`);
              process.exit(1);
            }
            
            if (attempt < maxRetries) {
              console.log(`🔄 ${2000 * attempt}ms後にリトライします...`);
              await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
              continue;
            }
          } else {
            console.error(`🌐 ネットワークエラー: ${blobName} - ${fetchError instanceof Error ? fetchError.message : fetchError}`);
            if (attempt < maxRetries) {
              console.log(`🔄 ${1000 * attempt}ms後にリトライします...`);
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
              continue;
            }
          }
        }
      } catch (error) {
        console.error(`💥 インデックス送信エラー: ${blobName} (試行 ${attempt}/${maxRetries}):`, error);
        
        if (attempt < maxRetries) {
          console.log(`🔄 ${1000 * attempt}ms後にリトライします...`);
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      }
    }
    
    return {
      success: false,
      blobName,
      source: indexType,
      error: `${maxRetries}回のリトライ後も失敗`
    };
  }

  /**
   * 指定されたソースのMHTMLファイルをインデックス
   */
  async indexSourceMhtmlFiles(
    source: 'qast' | 'stock',
    options: {
      concurrency?: number;
      dryRun?: boolean;
      delayMs?: number;
    } = {}
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    results: IndexingResult[];
  }> {
    const containerName = source === 'qast' ? 'qast-mhtml' : 'stock-mhtml';
    const blobPrefix = source === 'qast' ? 'qast-mhtml/data' : 'stock-mhtml/data';
    
    const {
      concurrency = parseInt(process.env.CONCURRENCY || '3'),
      dryRun = false,
      delayMs = parseInt(process.env.DELAY_MS || '500')
    } = options;

    console.log(`🔍 ${source.toUpperCase()} MHTMLインデックス処理開始...`);
    console.log(`📁 コンテナ: ${containerName}`);
    console.log(`📁 Blobプレフィックス: ${blobPrefix}`);
    console.log(`⚡ 並列数: ${concurrency}`);
    console.log(`⏱️ API間隔: ${delayMs}ms`);

    try {
      // 接続テスト
      console.log('\n1️⃣ Azure Storage接続確認中...');
      if (!dryRun) {
        await this.blobServiceClient.getProperties();
        console.log('✅ Azure Blob Storage接続テスト成功');
      }

      // MHTML Blobの一覧取得
      console.log(`\n2️⃣ ${source.toUpperCase()} MHTML Blob一覧取得中...`);
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const allBlobs: string[] = [];
      
      for await (const blob of containerClient.listBlobsFlat({ prefix: blobPrefix })) {
        if (blob.name.endsWith('.mhtml')) {
          allBlobs.push(blob.name);
        }
      }
      
      console.log(`📋 見つかったMHTMLファイル: ${allBlobs.length}件`);
      
      if (allBlobs.length === 0) {
        console.log('⚠️  インデックス対象のMHTMLファイルがありません');
        return { total: 0, success: 0, failed: 0, results: [] };
      }

      if (dryRun) {
        console.log('\n🔍 ドライラン - 見つかったファイル:');
        allBlobs.forEach((blob, index) => {
          console.log(`  ${index + 1}. ${blob}`);
        });
        console.log('\n🔍 ドライラン完了: 実際の送信は実行されませんでした');
        return { total: allBlobs.length, success: 0, failed: 0, results: [] };
      }

      // 並列処理でインデックス送信
      console.log('\n3️⃣ インデックス送信開始...');
      const results: IndexingResult[] = [];
      
      for (let i = 0; i < allBlobs.length; i += concurrency) {
        const batch = allBlobs.slice(i, i + concurrency);
        const batchNumber = Math.floor(i / concurrency) + 1;
        const totalBatches = Math.ceil(allBlobs.length / concurrency);
        
        console.log(`\n📦 バッチ ${batchNumber}/${totalBatches}: ${batch.length}ファイル`);
        
        const batchPromises = batch.map(async (blobName, index) => {
          try {
            // API間隔のための待機時間
            if (index > 0) {
              console.log(`⏳ API間隔待機: ${delayMs}ms (${blobName})`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            
            // ファイルをダウンロード
            console.log(`📥 Blobダウンロード開始: ${blobName}`);
            const downloadStart = Date.now();
            const fileBuffer = await this.downloadBlob(containerName, blobName);
            const downloadDuration = Date.now() - downloadStart;
            console.log(`📥 Blobダウンロード完了: ${blobName} (${downloadDuration}ms, ${Math.round(fileBuffer.length / 1024)}KB)`);
            
            // MHTMLファイルからContent-Location URLを抽出
            let sourceUrl = this.extractContentLocationUrl(fileBuffer);
            
            // Content-Locationが見つからない場合は、ファイル名から推測（フォールバック）
            if (!sourceUrl) {
              console.log('📎 ファイル名からURLを推測します...');
              sourceUrl = this.extractSourceUrl(source, blobName);
            }
            
            // インデックス送信
            return await this.indexMhtmlFile(containerName, blobName, fileBuffer, source, sourceUrl);
          } catch (error) {
            return {
              success: false,
              blobName,
              source,
              error: error instanceof Error ? error.message : 'Unknown error'
            };
          }
        });
        
        const batchResults = await Promise.allSettled(batchPromises);
        
        batchResults.forEach((result, index) => {
          const blobName = batch[index];
          
          if (result.status === 'fulfilled') {
            results.push(result.value);
          } else {
            results.push({
              success: false,
              blobName,
              source,
              error: result.reason?.toString() || 'Unknown error'
            });
          }
        });
        
        // バッチ間の待機時間
        if (i + concurrency < allBlobs.length) {
          const batchDelayMs = 500;
          console.log(`⏳ バッチ間待機: ${batchDelayMs}ms`);
          await new Promise(resolve => setTimeout(resolve, batchDelayMs));
        }
      }

      // 結果レポート
      const total = results.length;
      const success = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      
      console.log(`\n📊 ${source.toUpperCase()} インデックス処理完了`);
      console.log('='.repeat(60));
      console.log(`📈 総ファイル数: ${total}`);
      console.log(`✅ 成功: ${success}件`);
      console.log(`❌ 失敗: ${failed}件`);
      
      if (failed > 0) {
        console.log('\n🚨 失敗したファイル:');
        results.filter(r => !r.success).forEach(result => {
          console.log(`  - ${result.blobName}: ${result.error}`);
        });
      }

      return { total, success, failed, results };

    } catch (error) {
      console.error(`❌ ${source.toUpperCase()} インデックス処理に失敗しました:`, error);
      throw error;
    }
  }

  /**
   * 全MHTMLファイルをBlobから取得してインデックス送信
   */
  async indexAllMhtmlFiles(options: {
    targetSource?: 'qast' | 'stock' | 'all';
    concurrency?: number;
    dryRun?: boolean;
    delayMs?: number;
  } = {}): Promise<{
    qast?: { total: number; success: number; failed: number; results: IndexingResult[] };
    stock?: { total: number; success: number; failed: number; results: IndexingResult[] };
    combined: { total: number; success: number; failed: number };
  }> {
    const targetSource = options.targetSource || (process.env.TARGET_SOURCE as 'qast' | 'stock' | 'all') || 'all';
    
    console.log('🔍 MHTML Blob インデックス処理開始...');
    console.log('='.repeat(60));
    console.log(`🎯 対象ソース: ${targetSource}`);
    console.log(`📡 インデックスエンドポイント: ${this.indexEndpoint}`);
    console.log(`🔄 最大連続タイムアウト: ${this.MAX_CONSECUTIVE_TIMEOUTS}回`);
    if (options.dryRun) console.log('🔍 ドライランモード（実際の送信なし）');
    console.log('='.repeat(60));

    const results: {
      qast?: { total: number; success: number; failed: number; results: IndexingResult[] };
      stock?: { total: number; success: number; failed: number; results: IndexingResult[] };
      combined: { total: number; success: number; failed: number };
    } = {
      combined: { total: 0, success: 0, failed: 0 }
    };

    try {
      // QASTの処理
      if (targetSource === 'qast' || targetSource === 'all') {
        console.log('\n📂 QAST MHTMLファイルの処理を開始...\n');
        results.qast = await this.indexSourceMhtmlFiles('qast', options);
        results.combined.total += results.qast.total;
        results.combined.success += results.qast.success;
        results.combined.failed += results.qast.failed;
      }

      // STOCKの処理
      if (targetSource === 'stock' || targetSource === 'all') {
        if (targetSource === 'all') {
          console.log('\n' + '='.repeat(60) + '\n');
        }
        console.log('\n📂 STOCK MHTMLファイルの処理を開始...\n');
        results.stock = await this.indexSourceMhtmlFiles('stock', options);
        results.combined.total += results.stock.total;
        results.combined.success += results.stock.success;
        results.combined.failed += results.stock.failed;
      }

      // 最終レポート
      console.log('\n' + '='.repeat(60));
      console.log('📊 全体の処理結果');
      console.log('='.repeat(60));
      if (results.qast) {
        console.log(`📋 QAST: 総数${results.qast.total}件 (成功${results.qast.success}件, 失敗${results.qast.failed}件)`);
      }
      if (results.stock) {
        console.log(`📋 STOCK: 総数${results.stock.total}件 (成功${results.stock.success}件, 失敗${results.stock.failed}件)`);
      }
      console.log(`📊 合計: 総数${results.combined.total}件 (成功${results.combined.success}件, 失敗${results.combined.failed}件)`);
      console.log(`⏰ 総タイムアウト回数: ${this.consecutiveTimeouts}回`);

      return results;

    } catch (error) {
      console.error('❌ インデックス処理に失敗しました:', error);
      throw error;
    }
  }

  /**
   * MHTMLファイルからContent-LocationのURLを抽出
   */
  private extractContentLocationUrl(mhtmlContent: Buffer): string | undefined {
    try {
      const content = mhtmlContent.toString('utf-8');
      
      // Content-Location: で始まる行を探す
      const contentLocationMatch = content.match(/Content-Location:\s*(.+)/i);
      
      if (contentLocationMatch) {
        const url = contentLocationMatch[1].trim();
        console.log(`📍 Content-Location URL found: ${url}`);
        return url;
      }
      
      console.log('⚠️  Content-Location URLが見つかりません');
      return undefined;
    } catch (error) {
      console.error('❌ Content-Location URL抽出エラー:', error);
      return undefined;
    }
  }

  /**
   * BlobパスからソースURLを推測（フォールバック用）
   */
  private extractSourceUrl(source: 'qast' | 'stock', blobName: string): string | undefined {
    if (source === 'stock') {
      const match = blobName.match(/stock_(\d+)\.mhtml$/);
      if (match) {
        const stockId = match[1];
        return `https://www.stock-app.jp/teams/c20282/dashboard/all/stocks/${stockId}/edit`;
      }
    } else if (source === 'qast') {
      // QASTのURL形式に応じて実装
      const match = blobName.match(/qast_(\d+)\.mhtml$/);
      if (match) {
        const qastId = match[1];
        return `https://qast.jp/teams/xxxxx/posts/${qastId}`;
      }
    }
    
    return undefined;
  }

  /**
   * Blob名からAzure Blob StorageのURLを生成
   */
  private generateBlobUrl(containerName: string, blobName: string): string {
    const storageAccount = process.env.AZURE_STORAGE_ACCOUNT_NAME || 'yuyamablobstorage';
    return `https://${storageAccount}.blob.core.windows.net/${containerName}/${blobName}`;
  }
}