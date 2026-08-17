# google-mcp

Google API の MCP (Model Context Protocol) サーバー群をまとめた pnpm workspace モノレポ。

## Packages

| パッケージ | 説明 |
|---|---|
| [`packages/auth`](packages/auth/) | 共通パッケージ（OAuth 認証 (PKCE) / env 解決 / allowlist 判定 / ツール戻り値ヘルパー） |
| [`packages/calendar`](packages/calendar/) | Google Calendar MCP サーバー |
| [`packages/gmail`](packages/gmail/) | Gmail MCP サーバー |
| [`packages/sheets`](packages/sheets/) | Google Sheets MCP サーバー |
| [`packages/docs`](packages/docs/) | Google Docs MCP サーバー |
| [`packages/slides`](packages/slides/) | Google Slides MCP サーバー |
| [`packages/apps-script`](packages/apps-script/) | Apps Script MCP サーバー |
| [`packages/all`](packages/all/) | 全サービス統合エントリ（`.mcpb` 配布用。ツール名にサービス prefix を付与） |

## Tools

| サービス | 読み取り | 書き込み | 意図的に提供しない操作 |
|---|---|---|---|
| Sheets | list / get / get-values / export-pdf | update / append / clear-values / delete-rows / add-sheet / create-spreadsheet / create-from-template | シート削除・ファイル削除 |
| Docs | list / list-folder / read / search / get-comments / export-pdf | create-document / update-document (全置換) / replace-text (部分編集) / reply-comment / resolve-comment | ファイル削除 |
| Slides | list / list-folder / read / raw-structure / thumbnail / search / export-pdf | create / create-from-template / replace-text / batch-update | ファイル削除 |
| Apps Script | list / get-project / get-content / list-executions (実行履歴) | update-content / run-function (最新保存コードを実行) | **デプロイ・バージョン管理**（意図的に非提供） |
| Calendar | get-current-time / list-events / freebusy | create / update / delete-event | — |
| Gmail | search / get-messages / get-threads / download-attachments / list-labels | create-draft (BCC・添付対応) / modify-labels | **送信**（下書きまで。送信は人間が行う） |

書き込みは allowlist（後述の Config）で `access: readwrite` が付いたリソースに限定される。
Apps Script の `run-function` はさらに強い `access: execute` の個別登録が必要（folder 継承不可）。

## Setup

### 1. GCP プロジェクトの準備

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 使いたい API を有効化（Calendar / Gmail / Sheets / Docs / Slides / Drive / Apps Script）
3. OAuth 同意画面を設定
4. OAuth 2.0 クライアント ID を作成（デスクトップアプリ）
5. 認証情報の JSON ファイルをダウンロード → `credentials.json` として保存

`run-function`（Apps Script 実行）を使う場合は、対象スクリプトのプロジェクト設定でこの GCP プロジェクトへの紐づけが必要。

### 2. MCP 設定

`npx` で npm から直接実行できます。

```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@shivaduke28/google-calendar-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_MCP_CONFIG": "/path/to/config.json"
      }
    },
    "gmail": {
      "command": "npx",
      "args": ["-y", "@shivaduke28/gmail-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json"
      }
    },
    "google-sheets": {
      "command": "npx",
      "args": ["-y", "@shivaduke28/google-sheets-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_MCP_CONFIG": "/path/to/config.json"
      }
    },
    "google-docs": {
      "command": "npx",
      "args": ["-y", "@shivaduke28/google-docs-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_MCP_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

### 3. 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `GOOGLE_OAUTH_CREDENTIALS` | Yes | OAuth クライアント認証情報の JSON ファイルパス |
| `GOOGLE_MCP_CONFIG` | No | 共通設定ファイルパス（calendar 以外の allowlist と calendar の権限設定） |
| `GOOGLE_OAUTH_TOKENS` | No | トークン保存先（デフォルト: `~/.config/<package>-mcp/tokens.json`） |
| `GOOGLE_OAUTH_SCOPES` | No | スコープの上書き（スペース区切り。統合配布で union scope を渡す用途） |

パスには `~` が使えます（`$HOME` に展開されます）。

### 4. 認証

初回起動時にブラウザが開き、Google アカウントでの認証を求められます。認証後、トークンは `~/.config/<package>-mcp/tokens.json` に自動保存されます。PKCE (Proof Key for Code Exchange) に対応。

## Config

`GOOGLE_MCP_CONFIG` で指定する JSON ファイルに、各パッケージの設定をまとめて記述できます。

```json
{
  "calendar": {
    "internalDomain": "example.com",
    "permissions": {
      "read": { "self_only": "allow", "internal": "allow", "external": "allow" },
      "create": { "self_only": "allow", "internal": "deny", "external": "deny" },
      "update": { "self_only": "allow", "internal": "deny", "external": "deny" },
      "delete": { "self_only": "deny", "internal": "deny", "external": "deny" }
    }
  },
  "sheets": {
    "allowedSpreadsheets": [
      { "id": "spreadsheet-id", "name": "表示名", "access": "readwrite" }
    ]
  },
  "docs": {
    "allowedDocuments": [
      { "id": "document-id", "name": "表示名" }
    ]
  },
  "slides": {
    "allowedPresentations": [
      { "id": "presentation-id", "name": "表示名" }
    ]
  },
  "apps-script": {
    "allowedProjects": [
      { "id": "script-id", "name": "表示名", "access": "execute" }
    ]
  },
  "allowedFolders": [
    { "id": "folder-id", "name": "表示名", "access": "readonly" }
  ]
}
```

- 各パッケージは自分のキー（`calendar`, `sheets`, `docs`, `slides`, `apps-script`）のみを読み込む
- ルートの `allowedFolders` は **全サービス共通** のフォルダ許可。登録フォルダの配下（子孫フォルダ含む）が対象になり、フォルダの `access` を継承する
- 個別登録がフォルダ設定より優先される（readonly フォルダ内の特定ファイルだけ readwrite にする等）
- `access` は `deny` / `readonly` (デフォルト) / `readwrite`、apps-script のみ `execute` あり（execute は folder 継承不可）
- allowlist 未設定の場合、読み取りは全許可・書き込みは全拒否

## .mcpb 配布（社内向け）

全サービスを 1 つにまとめた Claude Desktop 拡張は `packages/all` をエントリに esbuild で単一ファイル化し、
credentials 同封で `.mcpb` にパックして配布する（パッケージングは別リポジトリ。credentials を含むため公開リポジトリには置かない）。

## Development

### ビルド・テスト

```bash
pnpm install          # 依存解決
pnpm build            # 全パッケージビルド
pnpm typecheck        # 全パッケージ型チェック
pnpm -r test          # 全パッケージテスト
```

### ローカルビルドで MCP サーバーを起動

ビルド済みの `dist/index.js` を直接指定して起動することもできます。

```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "node",
      "args": ["/path/to/google-mcp/packages/calendar/dist/index.js"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_MCP_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

## License

ISC
