# google-mcp

Google API の MCP サーバー群の pnpm workspace モノレポ。

## プロジェクト構成

```
packages/
  auth/        共通パッケージ（OAuth認証・env解決・allowlist判定・ツール戻り値ヘルパー。npm公開なし）
  calendar/    Google Calendar MCP サーバー
  gmail/       Gmail MCP サーバー
  sheets/      Google Sheets MCP サーバー
  docs/        Google Docs MCP サーバー
  slides/      Google Slides MCP サーバー
  apps-script/ Apps Script MCP サーバー（実行・履歴閲覧あり、デプロイ系は意図的に非提供）
  all/         全サービス統合エントリ（.mcpb 配布用。ツール名にサービス prefix を付与）
```

## ビルド・テスト

```bash
pnpm build        # 全パッケージビルド（pnpm -r build）
pnpm typecheck    # 全パッケージ型チェック（pnpm -r typecheck）
pnpm -r test      # 全パッケージテスト
```

個別パッケージ:
```bash
pnpm --filter @senchabrew/google-calendar-mcp build
pnpm --filter @senchabrew/google-calendar-mcp test
```

## アーキテクチャ

- **auth パッケージ**: OAuth2 認証 + PKCE を提供。各パッケージが `authorize(credentialsPath, tokensPath, scopes)` で利用
- **共通ブートストラップ**: 環境変数 (GOOGLE_OAUTH_SCOPES / CREDENTIALS / TOKENS / GOOGLE_MCP_CONFIG) の解決は `resolveServiceEnv(tokensDirName, defaultScopes)` に集約
- **ツール戻り値**: `textResult` / `toonResult` / `errorResult` (auth パッケージ) を使う
- **config**: `GOOGLE_MCP_CONFIG` 環境変数で1つの JSON ファイルを共有。`loadConfig<T>(configPath, key)` で各パッケージが自分のキーだけ読む。新規作成リソースの allowlist 自動登録は `appendAllowlistEntry`
- **パーミッション**: calendar はドメインベース（self_only/internal/external）、それ以外は allowlist ベース（サービス別の個別登録 + 共通 allowedFolders 継承）。apps-script のみ execute レベルあり（folder 継承不可）
- **lazy auth**: MCP サーバー起動時ではなく、最初のツール呼び出し時に認証する
- **TOON**: レスポンスは TOON 形式（`@toon-format/toon`）で返す

## パッケージ間の依存

- calendar, gmail, sheets → auth（`@senchabrew/google-mcp-auth` を `workspace:*` で参照）
- auth は `declaration: true` で型定義を出力

## テスト

- Node.js 組み込みテストランナー（`node:test` + `node:assert`）を使用
- `tsx --test test/*.test.ts` で実行
- calendar: permissions のユニットテスト（25テスト）
- gmail: ヘッダー抽出・本文デコード・メッセージ構築のユニットテスト（15テスト）
