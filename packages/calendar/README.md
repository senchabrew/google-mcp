# @senchabrew/google-calendar-mcp

Google Calendar API の MCP (Model Context Protocol) サーバー。

参加者の所属ドメインに基づくパーミッション制御により、外部参加者を含むイベントの変更・削除をサーバー側でブロックできます。

## Tools

| ツール | 説明 |
|---|---|
| `get-current-time` | 現在の日時を取得する |
| `list-events` | 1人または複数人のカレンダーのイベント一覧を取得する（TOON形式） |
| `create-event` | カレンダーイベントを作成する（ゲスト指定可） |
| `update-event` | カレンダーイベントを更新する（ゲスト変更可） |
| `delete-event` | カレンダーイベントを削除する |

`list-events` のレスポンスは [TOON](https://github.com/toon-format/toon) 形式で返されます。

## Setup

### 1. GCP プロジェクトの準備

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. Google Calendar API を有効化
3. OAuth 同意画面を設定
4. OAuth 2.0 クライアント ID を作成（デスクトップアプリ）
5. 認証情報の JSON ファイルをダウンロード → `credentials.json` として保存

### 2. 使い方

#### npx（推奨）

```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@senchabrew/google-calendar-mcp"],
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
    "google-calendar": {
      "command": "node",
      "args": ["/path/to/google-mcp/packages/calendar/dist/index.js"],
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
| `GOOGLE_MCP_CONFIG` | No | 共通設定ファイルパス。`calendar` キーから設定を読み込む |

### 4. 認証

初回起動時にブラウザが開き、Google アカウントでの認証を求められます。認証後、トークンは `~/.config/google-calendar-mcp/tokens.json` に自動保存され、以降はブラウザ認証なしで起動できます。

PKCE (Proof Key for Code Exchange) に対応しています。

## Config

`GOOGLE_MCP_CONFIG` で指定した JSON ファイルの `calendar` キーから設定を読み込みます。未指定の場合はデフォルト設定が使用されます。デフォルトでは自分のイベントの読み取り・作成・更新のみ許可し、削除と他者のイベント変更は拒否します。

```json
{
  "calendar": {
    "internalDomain": "",
    "permissions": {
      "read": { "self_only": "allow", "internal": "allow", "external": "allow" },
      "create": { "self_only": "allow", "internal": "deny", "external": "deny" },
      "update": { "self_only": "allow", "internal": "deny", "external": "deny" },
      "delete": { "self_only": "deny", "internal": "deny", "external": "deny" }
    }
  }
}
```

### 参加者の条件

各操作ごとに、参加者の条件に基づいて `allow` / `deny` を指定します。

| 条件 | 説明 |
|---|---|
| `self_only` | 参加者が自分のみ（または参加者なし） |
| `internal` | 他の参加者が全員 `internalDomain` に属する |
| `external` | `internalDomain` 外の参加者が含まれる |

## Development

```bash
pnpm install
pnpm --filter @senchabrew/google-calendar-mcp dev          # tsx で開発実行
pnpm --filter @senchabrew/google-calendar-mcp build        # tsc でビルド
pnpm --filter @senchabrew/google-calendar-mcp typecheck    # 型チェック
```

## License

ISC
