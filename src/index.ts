import { MhtmlBlobIndexer } from './mhtmlBlobIndexer.js';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('🚀 MHTML Blob Indexer 起動中...\n');
  
  const indexer = new MhtmlBlobIndexer();
  
  // コマンドライン引数の解析
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const targetSource = args.includes('--source') ? 
    args[args.indexOf('--source') + 1] as 'qast' | 'stock' | 'all' : 
    (process.env.TARGET_SOURCE as 'qast' | 'stock' | 'all') || 'all';
  const concurrency = args.includes('--concurrency') ? 
    parseInt(args[args.indexOf('--concurrency') + 1]) || 3 : 
    parseInt(process.env.CONCURRENCY || '3');
  const delayMs = args.includes('--delay') ? 
    parseInt(args[args.indexOf('--delay') + 1]) || 500 : 
    parseInt(process.env.DELAY_MS || '500');
  
  console.log('⚙️  実行設定:');
  console.log(`   ├─ 対象ソース: ${targetSource}`);
  console.log(`   ├─ ドライラン: ${dryRun ? '有効' : '無効'}`);
  console.log(`   ├─ 並列数: ${concurrency}`);
  console.log(`   └─ API間隔: ${delayMs}ms`);
  console.log('');
  
  try {
    await indexer.indexAllMhtmlFiles({
      targetSource,
      dryRun,
      concurrency,
      delayMs
    });
    
    console.log('\n🎉 MHTML Blob インデックス処理が完了しました！');
  } catch (error) {
    console.error('\n❌ MHTML Blob インデックス処理中にエラーが発生しました:', error);
    process.exit(1);
  }
}

// ヘルプメッセージ
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
MHTML Blob Indexer - Azure Blob StorageからMHTMLファイルをRAGシステムにインデックス

使用方法:
  npm start [オプション]

オプション:
  --source <qast|stock|all>  インデックス対象のソース (デフォルト: all)
  --dry-run                  実際の送信を行わずにファイル一覧のみ表示
  --concurrency <number>     並列処理数 (デフォルト: 3)
  --delay <number>          API呼び出し間の遅延（ミリ秒） (デフォルト: 500)
  --help, -h                このヘルプを表示

環境変数:
  TARGET_SOURCE             インデックス対象のソース (qast|stock|all)
  CONCURRENCY               並列処理数
  DELAY_MS                  API呼び出し間の遅延（ミリ秒）
  TIMEOUT_MS                APIタイムアウト時間（ミリ秒）
  MAX_RETRIES               最大リトライ回数
  MAX_CONSECUTIVE_TIMEOUTS  連続タイムアウト上限

例:
  # 全ソースをインデックス
  npm start

  # QASTのみをドライランで確認
  npm start --source qast --dry-run

  # STOCKのみを高速でインデックス
  npm start --source stock --concurrency 5 --delay 200
`);
  process.exit(0);
}

// メイン関数の実行
main().catch(error => {
  console.error('❌ 予期しないエラーが発生しました:', error);
  process.exit(1);
});