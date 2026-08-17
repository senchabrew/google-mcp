# @senchabrew/google-slides-mcp

Google Slides の MCP サーバー。allowlist ベースのアクセス制御で、許可されたプレゼンテーションとフォルダ内のプレゼンテーションのみ読み取り可能。

## Setup

### 1. GCP プロジェクト

Google Drive API と Google Slides API を有効化してください（[Google Cloud Console](https://console.cloud.google.com/)）。write 系ツールを使う場合は `presentations` / `drive` の書き込みスコープに同意が必要です（スコープ変更時は再認証が走ります）。

### 2. MCP 設定

```json
{
  "mcpServers": {
    "google-slides": {
      "command": "npx",
      "args": ["-y", "@senchabrew/google-slides-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_MCP_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

## Config

`GOOGLE_MCP_CONFIG` で指定する JSON ファイルの `slides` セクションに設定を記述します。

```json
{
  "slides": {
    "allowedPresentations": [
      { "id": "presentation-file-id", "name": "表示名" }
    ]
  },
  "common": {
    "allowedFolders": [
      { "id": "folder-id", "name": "表示名" }
    ]
  }
}
```

- `allowedPresentations`: 個別に許可するプレゼンテーション（Google Slides の URL `/d/XXXXX/` の部分がID）
- `allowedFolders`（common セクション）: フォルダ単位で許可（フォルダ内の Google Slides がすべてアクセス可能に）
- 両方未設定の場合はすべてのプレゼンテーションにアクセス可能

## Tools

| ツール | 種別 | 説明 |
|--------|------|------|
| `list-presentations` | read | allowlist に登録されたプレゼンテーション・フォルダの一覧 |
| `list-folder` | read | 許可されたフォルダ内の Google Slides ファイル一覧 |
| `read-presentation` | read | Google Slides の内容をスライド単位（本文＋スピーカーノート）で取得 |
| `search-presentations` | read | 許可された範囲内で Google Slides をファイル名検索 |
| `create-presentation` | write | 空のプレゼンテーションを新規作成し allowlist に readwrite で自動登録 |
| `create-from-template` | write | テンプレ Slides をコピーして新規作成し allowlist に readwrite で自動登録 |
| `replace-text` | write | テキストを一括置換（`{{placeholder}}` 置換など） |
| `batch-update` | write | 任意の `presentations.batchUpdate` リクエストを実行（スライド追加・図形/画像挿入など全操作） |

write 系ツールは `access: readwrite` の allowlist 登録が必須です（`create-*` は作成物を自動で readwrite 登録）。

## Scopes

- `https://www.googleapis.com/auth/presentations`
- `https://www.googleapis.com/auth/drive`
