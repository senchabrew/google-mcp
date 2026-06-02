#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { encode } from "@toon-format/toon";
import { authorize, resolvePath } from "@shivaduke28/google-mcp-auth";
import { drive as googleDrive } from "@googleapis/drive";
import { loadConfigs, checkAccess, checkFolderAccess } from "./permissions.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

const GOOGLE_DOCS_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const rawCredentialsPath = process.env.GOOGLE_OAUTH_CREDENTIALS;
const configPath = process.env.GOOGLE_MCP_CONFIG
  ? resolvePath(process.env.GOOGLE_MCP_CONFIG)
  : undefined;

if (!rawCredentialsPath) {
  console.error("GOOGLE_OAUTH_CREDENTIALS 環境変数を設定してください");
  process.exit(1);
}
const credentialsPath = resolvePath(rawCredentialsPath);
if (!existsSync(credentialsPath)) {
  console.error(`credentials.json が見つかりません: ${credentialsPath}`);
  process.exit(1);
}

const resolvedCredentialsPath: string = credentialsPath;
const resolvedTokensPath: string = process.env.GOOGLE_OAUTH_TOKENS
  ? resolvePath(process.env.GOOGLE_OAUTH_TOKENS)
  : join(homedir(), ".config", "google-docs-mcp", "tokens.json");

// パーミッション設定 (own + common)
const { permission: permConfig, common: commonConfig } = await loadConfigs(configPath);

// lazy auth: ツール呼び出し時に初めて認証する
let driveClient: ReturnType<typeof googleDrive> | null = null;

async function getDrive() {
  if (!driveClient) {
    const auth = await authorize(
      resolvedCredentialsPath,
      resolvedTokensPath,
      SCOPES
    );
    driveClient = googleDrive({ version: "v3", auth });
  }
  return driveClient;
}

const server = new McpServer({
  name: "google-docs-mcp",
  version: "2.0.0",
});

// 1. list-documents
server.registerTool(
  "list-documents",
  {
    description:
      "allowlist に登録されたドキュメントと共通フォルダの一覧を返す。レスポンスは TOON 形式で返す。",
    inputSchema: {},
  },
  async () => {
    if (!permConfig && !commonConfig) {
      return {
        content: [
          {
            type: "text" as const,
            text: "allowlist が設定されていません。GOOGLE_MCP_CONFIG 環境変数で設定ファイルを指定してください。",
          },
        ],
      };
    }

    const documents = (permConfig?.allowedDocuments ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      type: "document",
    }));

    const folders = (commonConfig?.allowedFolders ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      type: "folder",
    }));

    const items = [...documents, ...folders];

    return {
      content: [
        {
          type: "text" as const,
          text:
            items.length > 0
              ? encode({ allowedItems: items })
              : "allowlist にドキュメント/フォルダが登録されていません。",
        },
      ],
    };
  }
);

// 2. list-folder
server.registerTool(
  "list-folder",
  {
    description:
      "許可されたフォルダ内の Google Docs ファイル一覧を取得する。allowedFolders に直接登録されたフォルダ、またはその子孫フォルダのみ。レスポンスは TOON 形式で返す。",
    inputSchema: {
      folderId: z.string().describe("フォルダID"),
      pageToken: z
        .string()
        .optional()
        .describe("次ページのトークン（ページネーション用）"),
    },
  },
  async ({ folderId, pageToken }) => {
    const drive = await getDrive();
    const { allowed, reason } = await checkFolderAccess(commonConfig, drive, folderId);
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }

    const res = await drive.files.list({
      q: `'${folderId}' in parents and (mimeType = '${GOOGLE_DOCS_MIME_TYPE}' or mimeType = '${GOOGLE_FOLDER_MIME_TYPE}') and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, modifiedTime, lastModifyingUser/displayName)",
      pageSize: 50,
      orderBy: "modifiedTime desc",
      pageToken: pageToken ?? undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = (res.data.files ?? []).map((file) => ({
      id: file.id ?? "",
      name: file.name ?? "",
      type: file.mimeType === GOOGLE_FOLDER_MIME_TYPE ? "folder" : "document",
      modifiedTime: file.modifiedTime ?? "",
      lastModifiedBy: file.lastModifyingUser?.displayName ?? "",
    }));

    const result: Record<string, unknown> = { files };
    if (res.data.nextPageToken) {
      result.nextPageToken = res.data.nextPageToken;
    }

    return {
      content: [
        {
          type: "text" as const,
          text:
            files.length > 0
              ? encode(result)
              : "フォルダ内に Google Docs が見つかりませんでした。",
        },
      ],
    };
  }
);

// 3. read-document
server.registerTool(
  "read-document",
  {
    description:
      "Google Docs のドキュメント内容を取得する。デフォルトは HTML 形式（見出し・リスト・テーブル等の構造を保持）。allowlist に登録されたドキュメント、または共通 allowedFolders 配下のドキュメントのみ読み取り可能。",
    inputSchema: {
      fileId: z
        .string()
        .describe(
          "ドキュメントのファイルID（Google DocsのURLの /d/XXXXX/ 部分）"
        ),
      format: z
        .enum(["html", "text"])
        .optional()
        .default("html")
        .describe(
          "出力形式。html: 見出し・リスト・テーブル等の構造を保持（デフォルト）、text: プレーンテキスト"
        ),
    },
  },
  async ({ fileId, format }) => {
    const drive = await getDrive();
    const { allowed, reason } = await checkAccess(permConfig, commonConfig, drive, fileId, false);
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }

    // mime type 確認
    const meta = await drive.files.get({
      fileId,
      fields: "id, name, mimeType, modifiedTime, lastModifyingUser/displayName",
      supportsAllDrives: true,
    });

    if (meta.data.mimeType !== GOOGLE_DOCS_MIME_TYPE) {
      return {
        content: [
          {
            type: "text" as const,
            text: `指定されたファイルは Google Docs ではありません (mimeType: ${meta.data.mimeType})。`,
          },
        ],
        isError: true,
      };
    }

    // Google Docs をエクスポート
    const exportMimeType = format === "text" ? "text/plain" : "text/html";
    const res = await drive.files.export({
      fileId,
      mimeType: exportMimeType,
    });

    const content = typeof res.data === "string" ? res.data : String(res.data);

    return {
      content: [
        {
          type: "text" as const,
          text: encode({
            document: {
              id: meta.data.id ?? fileId,
              name: meta.data.name ?? "",
              modifiedTime: meta.data.modifiedTime ?? "",
              lastModifiedBy: meta.data.lastModifyingUser?.displayName ?? "",
              format,
              content,
            },
          }),
        },
      ],
    };
  }
);

// 4. search-documents
server.registerTool(
  "search-documents",
  {
    description:
      "許可された共通 allowedFolders 内の Google Docs をファイル名で検索する。allowedDocuments も名前一致で含む。レスポンスは TOON 形式で返す。",
    inputSchema: {
      query: z
        .string()
        .describe("検索キーワード（ファイル名に対する部分一致検索）"),
    },
  },
  async ({ query }) => {
    if (!permConfig && !commonConfig) {
      return {
        content: [
          {
            type: "text" as const,
            text: "allowlist が設定されていません。GOOGLE_MCP_CONFIG 環境変数で設定ファイルを指定してください。",
          },
        ],
      };
    }

    const drive = await getDrive();
    const allFiles: Array<{
      id: string;
      name: string;
      modifiedTime: string;
      lastModifiedBy: string;
      folder: string;
    }> = [];
    const seenIds = new Set<string>();

    // 共通 allowedFolders 配下を検索 (サブフォルダ含む)
    const { getAllSubfolderIds } = await import("@shivaduke28/google-mcp-auth");
    for (const folder of commonConfig?.allowedFolders ?? []) {
      const subfolderIds = await getAllSubfolderIds(drive, folder.id);
      const folderIdsToSearch = [folder.id, ...subfolderIds];

      for (const searchFolderId of folderIdsToSearch) {
        const escapedQuery = query.replace(/'/g, "\\'");
        const res = await drive.files.list({
          q: `'${searchFolderId}' in parents and mimeType = '${GOOGLE_DOCS_MIME_TYPE}' and name contains '${escapedQuery}' and trashed = false`,
          fields:
            "files(id, name, modifiedTime, lastModifyingUser/displayName)",
          pageSize: 20,
          orderBy: "modifiedTime desc",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        for (const file of res.data.files ?? []) {
          const fileId = file.id ?? "";
          if (seenIds.has(fileId)) continue;
          seenIds.add(fileId);
          allFiles.push({
            id: fileId,
            name: file.name ?? "",
            modifiedTime: file.modifiedTime ?? "",
            lastModifiedBy: file.lastModifyingUser?.displayName ?? "",
            folder: folder.name,
          });
        }
      }
    }

    // allowedDocuments も名前でフィルタ
    const lowerQuery = query.toLowerCase();
    const matchedDocs = (permConfig?.allowedDocuments ?? [])
      .filter((doc) => doc.name.toLowerCase().includes(lowerQuery))
      .map((doc) => ({
        id: doc.id,
        name: doc.name,
        modifiedTime: "",
        lastModifiedBy: "",
        folder: "(直接登録)",
      }));

    const results = [...allFiles, ...matchedDocs];

    return {
      content: [
        {
          type: "text" as const,
          text:
            results.length > 0
              ? encode({ results })
              : `「${query}」に一致するドキュメントが見つかりませんでした。`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
