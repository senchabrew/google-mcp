# @senchabrew/google-docs-mcp

Google Docs の MCP サーバー。allowlist ベースのアクセス制御で、許可されたドキュメントとフォルダ内のドキュメントのみ読み取り可能。

## Setup

### 1. GCP プロジェクト

Google Drive API を有効化してください（[Google Cloud Console](https://console.cloud.google.com/)）。

### 2. MCP 設定

```json
{
  "mcpServers": {
    "google-docs": {
      "command": "npx",
      "args": ["-y", "@senchabrew/google-docs-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_MCP_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

## Config

`GOOGLE_MCP_CONFIG` で指定する JSON ファイルの `docs` セクションに設定を記述します。

```json
{
  "docs": {
    "allowedDocuments": [
      { "id": "document-file-id", "name": "表示名" }
    ],
    "allowedFolders": [
      { "id": "folder-id", "name": "表示名" }
    ]
  }
}
```

- `allowedDocuments`: 個別に許可するドキュメント（Google Docs の URL `/d/XXXXX/` の部分がID）
- `allowedFolders`: フォルダ単位で許可（フォルダ内の Google Docs がすべてアクセス可能に）
- 両方未設定の場合はすべてのドキュメントにアクセス可能

## Tools

| ツール | 説明 |
|--------|------|
| `list-documents` | allowlist に登録されたドキュメント・フォルダの一覧 |
| `list-folder` | 許可されたフォルダ内の Google Docs ファイル一覧 |
| `read-document` | Google Docs の内容をプレーンテキストとして取得 |
| `search-documents` | 許可された範囲内で Google Docs をファイル名検索 |

## Scopes

- `https://www.googleapis.com/auth/drive.readonly`
