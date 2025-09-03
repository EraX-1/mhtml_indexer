export interface MhtmlContent {
  html: string;
  text: string;
  title?: string;
  metadata: {
    encoding?: string;
    date?: string;
    from?: string;
    subject?: string;
  };
}

export class MhtmlParser {
  /**
   * MHTMLファイルからコンテンツを抽出
   */
  static parse(mhtmlContent: string | Buffer): MhtmlContent {
    const contentStr = mhtmlContent instanceof Buffer ? mhtmlContent.toString('utf-8') : mhtmlContent;
    
    // MHTMLヘッダーとコンテンツの境界を見つける
    const boundaryMatch = contentStr.match(/boundary="?([^"\s]+)"?/i);
    const boundary = boundaryMatch ? boundaryMatch[1] : null;
    
    // メタデータの抽出
    const metadata: MhtmlContent['metadata'] = {};
    
    const encodingMatch = contentStr.match(/Content-Type:.*charset="?([^"\s;]+)"?/i);
    if (encodingMatch) metadata.encoding = encodingMatch[1];
    
    const dateMatch = contentStr.match(/Date:\s*(.+)/i);
    if (dateMatch) metadata.date = dateMatch[1].trim();
    
    const fromMatch = contentStr.match(/From:\s*(.+)/i);
    if (fromMatch) metadata.from = fromMatch[1].trim();
    
    const subjectMatch = contentStr.match(/Subject:\s*(.+)/i);
    if (subjectMatch) metadata.subject = subjectMatch[1].trim();
    
    // HTMLコンテンツの抽出
    let htmlContent = '';
    
    if (boundary) {
      // マルチパートMHTML
      const parts = contentStr.split(new RegExp(`--${boundary}`));
      for (const part of parts) {
        if (part.includes('Content-Type: text/html')) {
          // HTMLパートを見つけた
          const htmlStart = part.indexOf('\n\n') + 2;
          if (htmlStart > 1) {
            htmlContent = part.substring(htmlStart).trim();
            break;
          }
        }
      }
    } else {
      // シンプルなHTML形式の場合
      const htmlMatch = contentStr.match(/<html[\s\S]*<\/html>/i);
      if (htmlMatch) {
        htmlContent = htmlMatch[0];
      }
    }
    
    // HTMLからテキストとタイトルを抽出
    const text = this.extractText(htmlContent);
    const title = this.extractTitle(htmlContent);
    
    return {
      html: htmlContent,
      text,
      title,
      metadata
    };
  }
  
  /**
   * HTMLからテキストを抽出
   */
  private static extractText(html: string): string {
    // スクリプトとスタイルタグを削除
    let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    
    // HTMLタグを削除
    text = text.replace(/<[^>]+>/g, ' ');
    
    // HTMLエンティティをデコード
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#039;/g, "'");
    
    // 連続する空白を単一のスペースに
    text = text.replace(/\s+/g, ' ');
    
    return text.trim();
  }
  
  /**
   * HTMLからタイトルを抽出
   */
  private static extractTitle(html: string): string | undefined {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : undefined;
  }
  
  /**
   * MHTMLコンテンツの検証
   */
  static isValidMhtml(content: string | Buffer): boolean {
    const contentStr = content instanceof Buffer ? content.toString('utf-8') : content;
    
    // 基本的なMHTMLの特徴をチェック
    const hasMimeVersion = /MIME-Version:/i.test(contentStr);
    const hasContentType = /Content-Type:/i.test(contentStr);
    const hasHtml = /<html/i.test(contentStr);
    
    return hasMimeVersion || hasContentType || hasHtml;
  }
}