import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

export interface DownloadResult {
  success: boolean;
  blobName: string;
  localPath?: string;
  size?: number;
  error?: string;
}

export interface BlobMetadata {
  name: string;
  size: number;
  lastModified: Date;
  contentType?: string;
}

export class AzureBlobDownloader {
  private blobServiceClient: BlobServiceClient;
  
  constructor() {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    
    console.log('🔍 Azure Storage設定確認中...');
    
    if (connectionString) {
      console.log('📝 Connection String方式で接続中...');
      this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else if (accountName && accountKey) {
      console.log('🔑 Account Name + Key方式で接続中...');
      const credential = {
        accountName,
        accountKey
      };
      this.blobServiceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential as any
      );
    } else {
      throw new Error(
        'Azure Storage接続情報が不足しています。以下のいずれかを.envファイルに設定してください:\n' +
        '1. AZURE_STORAGE_CONNECTION_STRING\n' +
        '2. AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY'
      );
    }
  }
  
  /**
   * 指定したコンテナ内のすべてのBlobをリスト
   */
  async listAllBlobs(containerName: string, prefix?: string): Promise<BlobMetadata[]> {
    try {
      console.log(`📋 Blob一覧を取得中... (コンテナ: ${containerName})`);
      
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const blobs: BlobMetadata[] = [];
      
      // ページングを使用してすべてのBlobを取得
      for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        blobs.push({
          name: blob.name,
          size: blob.properties.contentLength || 0,
          lastModified: blob.properties.lastModified || new Date(),
          contentType: blob.properties.contentType
        });
      }
      
      console.log(`✅ ${blobs.length}件のBlobが見つかりました`);
      return blobs;
    } catch (error) {
      console.error(`❌ Blob一覧取得エラー: ${error}`);
      throw error;
    }
  }
  
  /**
   * 複数のコンテナからBlobをリスト（qast-mhtml, stock-mhtml）
   */
  async listAllMhtmlBlobs(): Promise<{
    qast: BlobMetadata[];
    stock: BlobMetadata[];
    total: number;
  }> {
    console.log('🔍 全MHTMLファイルを検索中...');
    
    const [qastBlobs, stockBlobs] = await Promise.all([
      this.listAllBlobs('qast-mhtml').catch(() => []),
      this.listAllBlobs('stock-mhtml').catch(() => [])
    ]);
    
    const total = qastBlobs.length + stockBlobs.length;
    
    console.log(`📊 検索結果:`);
    console.log(`   - qast-mhtml: ${qastBlobs.length}件`);
    console.log(`   - stock-mhtml: ${stockBlobs.length}件`);
    console.log(`   - 合計: ${total}件`);
    
    return { qast: qastBlobs, stock: stockBlobs, total };
  }
  
  /**
   * 単一のBlobをダウンロード
   */
  async downloadBlob(
    containerName: string,
    blobName: string,
    localPath: string
  ): Promise<DownloadResult> {
    try {
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      // ディレクトリが存在しない場合は作成
      const dir = path.dirname(localPath);
      await fs.mkdir(dir, { recursive: true });
      
      // ダウンロード実行
      const downloadResponse = await blockBlobClient.download(0);
      
      if (!downloadResponse.readableStreamBody) {
        throw new Error('ダウンロードストリームが取得できません');
      }
      
      // Node.js用のストリーム処理
      const stream = downloadResponse.readableStreamBody as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      
      const buffer = Buffer.concat(chunks);
      await fs.writeFile(localPath, buffer);
      
      return {
        success: true,
        blobName,
        localPath,
        size: buffer.length
      };
    } catch (error) {
      return {
        success: false,
        blobName,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
  
  /**
   * BlobのコンテンツをBufferとして取得（メモリに読み込む）
   */
  async downloadBlobToBuffer(
    containerName: string,
    blobName: string
  ): Promise<{ buffer: Buffer; metadata: BlobMetadata }> {
    try {
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      // メタデータ取得
      const properties = await blockBlobClient.getProperties();
      
      // ダウンロード実行
      const downloadResponse = await blockBlobClient.download(0);
      
      if (!downloadResponse.readableStreamBody) {
        throw new Error('ダウンロードストリームが取得できません');
      }
      
      // Node.js用のストリーム処理
      const stream = downloadResponse.readableStreamBody as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      
      const buffer = Buffer.concat(chunks);
      
      return {
        buffer,
        metadata: {
          name: blobName,
          size: buffer.length,
          lastModified: properties.lastModified || new Date(),
          contentType: properties.contentType
        }
      };
    } catch (error) {
      console.error(`❌ ダウンロードエラー (${blobName}): ${error}`);
      throw error;
    }
  }
  
  /**
   * 接続テスト
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.blobServiceClient.getProperties();
      console.log('✅ Azure Blob Storage接続テスト成功');
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Azure Blob Storage接続テスト失敗:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }
  
  /**
   * ファイルサイズを人間が読みやすい形式に変換
   */
  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}