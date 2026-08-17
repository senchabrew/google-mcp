# @senchabrew/gmail-mcp

Gmail API の MCP (Model Context Protocol) サーバー。

OAuth スコープは `gmail.modify` のみ。送信・削除はできません。

## Tools

| ツール | 説明 |
|---|---|
| `search-messages` | Gmail 検索クエリでメール一覧を取得する（TOON形式） |
| `get-messages` | メッセージIDから本文を含む詳細を一括取得する |
| `get-threads` | スレッドIDからスレッド全体を一括取得する |
| `create-draft` | 下書きを作成する（返信にも対応） |
| `modify-labels` | ラベルの追加・削除（アーカイブ = INBOX 削除） |
| `list-labels` | 利用可能なラベル一覧を取得する |

レスポンスは [TOON](https://github.com/toon-format/toon) 形式で返されます。

## Setup

### 1. GCP プロジェクトの準備

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. Gmail API を有効化
3. OAuth 同意画面を設定
4. OAuth 2.0 クライアント ID を作成（デスクトップアプリ）
5. 認証情報の JSON ファイルをダウンロード → `credentials.json` として保存

### 2. 使い方

#### npx（推奨）

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "@senchabrew/gmail-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json"
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
    "gmail": {
      "command": "node",
      "args": ["/path/to/google-mcp/packages/gmail/dist/index.js"],
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

### 4. 認証

初回起動時にブラウザが開き、Google アカウントでの認証を求められます。認証後、トークンは `~/.config/gmail-mcp/tokens.json` に自動保存され、以降はブラウザ認証なしで起動できます。

PKCE (Proof Key for Code Exchange) に対応しています。

## Gmail 検索クエリの例

```
from:user@example.com
to:user@example.com
subject:会議
is:unread
has:attachment
newer_than:7d
after:2026/01/01
label:INBOX
```

組み合わせも可能: `from:example.com subject:請求書 after:2026/01/01`

## Development

```bash
pnpm install
pnpm --filter @senchabrew/gmail-mcp dev          # tsx で開発実行
pnpm --filter @senchabrew/gmail-mcp build        # tsc でビルド
pnpm --filter @senchabrew/gmail-mcp typecheck    # 型チェック
```

## License

ISC
