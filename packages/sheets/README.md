# @senchabrew/google-sheets-mcp

Google Sheets API の MCP (Model Context Protocol) サーバー。

allowlist 方式のパーミッション制御により、アクセス可能なスプレッドシートと読み書き権限を制御できます。

## Tools

| ツール | 説明 |
|---|---|
| `list-spreadsheets` | allowlist に登録されたスプレッドシート一覧を返す |
| `get-spreadsheet` | スプレッドシートのメタデータ（シート名一覧など）を取得する |
| `get-values` | 指定範囲のセル値を取得する（A1表記） |
| `update-values` | セル範囲に値を書き込む（readwrite のみ） |
| `append-values` | テーブルの末尾に行を追記する（readwrite のみ） |

レスポンスは [TOON](https://github.com/toon-format/toon) 形式で返されます。

## Setup

### 1. GCP プロジェクトの準備

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. Google Sheets API を有効化
3. OAuth 同意画面を設定
4. OAuth 2.0 クライアント ID を作成（デスクトップアプリ）
5. 認証情報の JSON ファイルをダウンロード → `credentials.json` として保存

### 2. 使い方

#### npx（推奨）

```json
{
  "mcpServers": {
    "google-sheets": {
      "command": "npx",
      "args": ["-y", "@senchabrew/google-sheets-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_MCP_CONFIG": "/path/to/google-mcp-config.json"
      }
    }
  }
}
```

#### ソースから実行

```bash
pnpm install
pnpm -r build
```

```json
{
  "mcpServers": {
    "google-sheets": {
      "command": "node",
      "args": ["/path/to/google-mcp/packages/sheets/dist/index.js"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json"
      }
    }
  }
}
```

### 3. 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `GOOGLE_OAUTH_CREDENTIALS` | Yes | OAuth クライアント認証情報の JSON ファイルパス |
| `GOOGLE_MCP_CONFIG` | No | 共通設定ファイルパス。`sheets` キーから設定を読み込む |

### 4. 認証

初回起動時にブラウザが開き、Google アカウントでの認証を求められます。認証後、トークンは `~/.config/google-sheets-mcp/tokens.json` に自動保存され、以降はブラウザ認証なしで起動できます。

PKCE (Proof Key for Code Exchange) に対応しています。

## Config

`GOOGLE_MCP_CONFIG` で指定した JSON ファイルの `sheets` キーから設定を読み込みます。未指定の場合は全スプレッドシートにアクセス可能です。

```json
{
  "sheets": {
    "allowedSpreadsheets": [
      {
        "id": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
        "name": "家計簿",
        "access": "readwrite"
      },
      {
        "id": "1AbCdEfGhIjKlMnOpQrStUvWxYz",
        "name": "レポート",
        "access": "readonly"
      }
    ]
  }
}
```

| フィールド | 説明 |
|---|---|
| `id` | スプレッドシートID（URLの `/d/` と `/edit` の間の文字列） |
| `name` | 人間が読める名前（表示用） |
| `access` | `readonly`（読み取りのみ）または `readwrite`（読み書き可） |

- allowlist が未設定（`GOOGLE_MCP_CONFIG` 未指定 or `sheets` キーなし）の場合は全スプレッドシートにアクセス可能
- allowlist が設定されている場合、リストにないスプレッドシートへのアクセスは拒否されます
- `readonly` のスプレッドシートに対する `update-values` / `append-values` は拒否されます

## Development

```bash
pnpm install
pnpm --filter @senchabrew/google-sheets-mcp dev          # tsx で開発実行
pnpm --filter @senchabrew/google-sheets-mcp build        # tsc でビルド
pnpm --filter @senchabrew/google-sheets-mcp typecheck    # 型チェック
```

## License

ISC
