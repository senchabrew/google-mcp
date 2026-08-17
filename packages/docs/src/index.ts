import { z } from "zod";
import {
  authorize,
  resolveServiceEnv,
  appendAllowlistEntry,
  getAllSubfolderIds,
  textResult,
  toonResult,
  errorResult,
} from "@shivaduke28/google-mcp-auth";
import { drive as googleDrive } from "@googleapis/drive";
import { docs as googleDocs } from "@googleapis/docs";
import { loadConfigs, checkAccess, checkFolderAccess } from "./permissions.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const GOOGLE_DOCS_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const { scopes, credentialsPath, tokensPath, configPath } = resolveServiceEnv(
  "google-docs-mcp",
  ["https://www.googleapis.com/auth/drive"]
);

// パーミッション設定は tool 呼び出しごとに loadConfigs() で最新を取得する
// (config.json を外部から変更しても即座に反映される)

// lazy auth: ツール呼び出し時に初めて認証する。drive / docs は同一 auth を共有する
let authClient: Awaited<ReturnType<typeof authorize>> | null = null;
let driveClient: ReturnType<typeof googleDrive> | null = null;
let docsClient: ReturnType<typeof googleDocs> | null = null;

async function getAuth() {
  if (!authClient) {
    authClient = await authorize(credentialsPath, tokensPath, scopes);
  }
  return authClient;
}

async function getDrive() {
  if (!driveClient) {
    driveClient = googleDrive({ version: "v3", auth: await getAuth() });
  }
  return driveClient;
}

async function getDocs() {
  if (!docsClient) {
    docsClient = googleDocs({ version: "v1", auth: await getAuth() });
  }
  return docsClient;
}

/** tool 呼び出しごとに最新権限を取得 */
async function resolveAccess(fileId: string, requireWrite: boolean) {
  const { permission, common } = await loadConfigs(configPath);
  const drive = common?.allowedFolders?.length ? await getDrive() : null;
  const check = await checkAccess(permission, common, drive, fileId, requireWrite);
  return { ...check, permission, common };
}

/** fileId が Google Docs か確認し、違えばエラーメッセージを返す */
async function assertDocsMimeType(fileId: string): Promise<string | null> {
  const drive = await getDrive();
  const meta = await drive.files.get({
    fileId,
    fields: "mimeType",
    supportsAllDrives: true,
  });
  if (meta.data.mimeType !== GOOGLE_DOCS_MIME_TYPE) {
    return `指定されたファイルは Google Docs ではありません (mimeType: ${meta.data.mimeType})。`;
  }
  return null;
}

export function register(server: McpServer) {
// 1. list-documents
server.registerTool(
  "list-documents",
  {
    description:
      "allowlist に登録されたドキュメントと共通フォルダの一覧を返す。レスポンスは TOON 形式で返す。",
    inputSchema: {},
  },
  async () => {
    const { permission, common } = await loadConfigs(configPath);
    if (!permission && !common) {
      return textResult(
        "allowlist が設定されていません。GOOGLE_MCP_CONFIG 環境変数で設定ファイルを指定してください。"
      );
    }

    const documents = (permission?.allowedDocuments ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      type: "document",
    }));

    const folders = (common?.allowedFolders ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      type: "folder",
    }));

    const items = [...documents, ...folders];
    return items.length > 0
      ? toonResult({ allowedItems: items })
      : textResult("allowlist にドキュメント/フォルダが登録されていません。");
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
  async ({ folderId, pageToken }: { folderId: string; pageToken?: string }) => {
    const { common } = await loadConfigs(configPath);
    const drive = await getDrive();
    const { allowed, reason } = await checkFolderAccess(common, drive, folderId);
    if (!allowed) return errorResult(reason!);

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

    return files.length > 0
      ? toonResult(result)
      : textResult("フォルダ内に Google Docs が見つかりませんでした。");
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
  async ({ fileId, format }: { fileId: string; format?: "html" | "text" }) => {
    const { allowed, reason } = await resolveAccess(fileId, false);
    if (!allowed) return errorResult(reason!);
    const drive = await getDrive();

    const meta = await drive.files.get({
      fileId,
      fields: "id, name, mimeType, modifiedTime, lastModifyingUser/displayName",
      supportsAllDrives: true,
    });

    if (meta.data.mimeType !== GOOGLE_DOCS_MIME_TYPE) {
      return errorResult(
        `指定されたファイルは Google Docs ではありません (mimeType: ${meta.data.mimeType})。`
      );
    }

    // Google Docs をエクスポート
    const exportMimeType = format === "text" ? "text/plain" : "text/html";
    const res = await drive.files.export({
      fileId,
      mimeType: exportMimeType,
    });

    const content = typeof res.data === "string" ? res.data : String(res.data);

    return toonResult({
      document: {
        id: meta.data.id ?? fileId,
        name: meta.data.name ?? "",
        modifiedTime: meta.data.modifiedTime ?? "",
        lastModifiedBy: meta.data.lastModifyingUser?.displayName ?? "",
        format,
        content,
      },
    });
  }
);

// 4. create-document
server.registerTool(
  "create-document",
  {
    description:
      "Google Docs を markdown から新規作成し、自動で allowlist に access: readwrite として登録する。作成後は MCP 再起動なしですぐに操作可能。",
    inputSchema: {
      name: z.string().describe("新規ドキュメントの名前"),
      content: z.string().describe("本文 (markdown。見出し・リスト・テーブル対応)"),
      parentFolderId: z
        .string()
        .optional()
        .describe("配置先フォルダ ID (省略時は Drive ルート)"),
    },
  },
  async ({ name, content, parentFolderId }: { name: string; content: string; parentFolderId?: string }) => {
    const drive = await getDrive();
    const requestBody: { name: string; mimeType: string; parents?: string[] } = {
      name,
      mimeType: GOOGLE_DOCS_MIME_TYPE,
    };
    if (parentFolderId) requestBody.parents = [parentFolderId];

    // media に markdown を渡すと Drive が Docs 形式へ変換する
    const res = await drive.files.create({
      requestBody,
      media: { mimeType: "text/markdown", body: content },
      fields: "id, name",
      supportsAllDrives: true,
    });
    const newId = res.data.id;
    if (!newId) {
      return errorResult("作成後のドキュメント ID 取得に失敗しました。");
    }

    const written = await appendAllowlistEntry(configPath, "docs", "allowedDocuments", {
      id: newId,
      name,
      access: "readwrite",
    });
    const persistedNote = written
      ? "config.json に永続化済み"
      : configPath
        ? "config.json 永続化に失敗"
        : "GOOGLE_MCP_CONFIG 未設定のため永続化されず";

    return textResult(
      `ドキュメント「${name}」を作成しました。\n  id: ${newId}\n  url: https://docs.google.com/document/d/${newId}/edit\n  allowlist: access: readwrite で登録済み (${persistedNote})`
    );
  }
);

// 5. update-document
server.registerTool(
  "update-document",
  {
    description:
      "Google Docs のドキュメント本文を markdown で全置換する(破壊的: 既存の本文・表・書式はすべて置き換わる)。部分的な修正には replace-text を使うこと。" +
      "allowlist で access: readwrite が付いたドキュメント、または readwrite フォルダ配下のみ。" +
      "markdown は Google Docs 形式に変換される(見出し・リスト・テーブル対応)。",
    inputSchema: {
      fileId: z
        .string()
        .describe(
          "ドキュメントのファイルID（Google DocsのURLの /d/XXXXX/ 部分）"
        ),
      content: z.string().describe("新しい本文(markdown)"),
    },
  },
  async ({ fileId, content }: { fileId: string; content: string }) => {
    const { allowed, reason } = await resolveAccess(fileId, true);
    if (!allowed) return errorResult(reason!);

    const mimeError = await assertDocsMimeType(fileId);
    if (mimeError) return errorResult(mimeError);

    // media upload で本文を置換(Drive が markdown → Docs 変換を行う)
    const drive = await getDrive();
    const res = await drive.files.update({
      fileId,
      supportsAllDrives: true,
      media: {
        mimeType: "text/markdown",
        body: content,
      },
      fields: "id, name, modifiedTime",
    });

    return toonResult({
      updated: {
        id: res.data.id ?? fileId,
        name: res.data.name ?? "",
        modifiedTime: res.data.modifiedTime ?? "",
      },
    });
  }
);

// 6. replace-text
server.registerTool(
  "replace-text",
  {
    description:
      "Google Docs 内のテキストを一括置換する（部分編集。本文全体は保持される）。検索文字列は完全一致で、ドキュメント内の全出現箇所が置換される。誤置換を防ぐため、検索文字列は前後の文脈を含めて一意になる長さで指定すること。allowlist で access: readwrite が付いたドキュメントのみ。",
    inputSchema: {
      fileId: z
        .string()
        .describe("ドキュメントのファイルID（Google DocsのURLの /d/XXXXX/ 部分）"),
      replacements: z
        .array(
          z.object({
            find: z.string().describe("検索文字列（完全一致・全出現箇所が対象）"),
            replaceWith: z.string().describe("置換後の文字列"),
            matchCase: z
              .boolean()
              .optional()
              .default(true)
              .describe("大文字小文字を区別するか"),
          })
        )
        .min(1)
        .describe("置換の配列（記載順に適用される）"),
    },
  },
  async ({
    fileId,
    replacements,
  }: {
    fileId: string;
    replacements: Array<{ find: string; replaceWith: string; matchCase?: boolean }>;
  }) => {
    const { allowed, reason } = await resolveAccess(fileId, true);
    if (!allowed) return errorResult(reason!);

    const mimeError = await assertDocsMimeType(fileId);
    if (mimeError) return errorResult(mimeError);

    const docsApi = await getDocs();
    const res = await docsApi.documents.batchUpdate({
      documentId: fileId,
      requestBody: {
        requests: replacements.map((r) => ({
          replaceAllText: {
            containsText: { text: r.find, matchCase: r.matchCase ?? true },
            replaceText: r.replaceWith,
          },
        })),
      },
    });

    const results = (res.data.replies ?? []).map((reply, i) => ({
      find: replacements[i]?.find ?? "",
      occurrencesChanged: reply.replaceAllText?.occurrencesChanged ?? 0,
    }));
    const notFound = results.filter((r) => r.occurrencesChanged === 0);

    return toonResult({
      results,
      ...(notFound.length > 0
        ? {
            warning: `${notFound.length}件の検索文字列が見つかりませんでした。read-document で現在の本文を確認してください。`,
          }
        : {}),
    });
  }
);

// 7. search-documents
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
  async ({ query }: { query: string }) => {
    const { permission, common } = await loadConfigs(configPath);
    if (!permission && !common) {
      return textResult(
        "allowlist が設定されていません。GOOGLE_MCP_CONFIG 環境変数で設定ファイルを指定してください。"
      );
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
    for (const folder of common?.allowedFolders ?? []) {
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
    const matchedDocs = (permission?.allowedDocuments ?? [])
      .filter((doc) => doc.name.toLowerCase().includes(lowerQuery))
      .map((doc) => ({
        id: doc.id,
        name: doc.name,
        modifiedTime: "",
        lastModifiedBy: "",
        folder: "(直接登録)",
      }));

    const results = [...allFiles, ...matchedDocs];
    return results.length > 0
      ? toonResult({ results })
      : textResult(`「${query}」に一致するドキュメントが見つかりませんでした。`);
  }
);

// 8. get-comments
server.registerTool(
  "get-comments",
  {
    description:
      "Google Docs のコメント（返信含む）一覧を取得する。allowlist に登録されたドキュメント、または共通 allowedFolders 配下のドキュメントのみ。レスポンスは TOON 形式で返す。",
    inputSchema: {
      fileId: z
        .string()
        .describe(
          "ドキュメントのファイルID（Google DocsのURLの /d/XXXXX/ 部分）"
        ),
      includeResolved: z
        .boolean()
        .optional()
        .default(true)
        .describe("解決済みコメントも含めるか（デフォルト true）"),
      pageToken: z
        .string()
        .optional()
        .describe("次ページのトークン（ページネーション用）"),
    },
  },
  async ({
    fileId,
    includeResolved,
    pageToken,
  }: {
    fileId: string;
    includeResolved?: boolean;
    pageToken?: string;
  }) => {
    const { allowed, reason } = await resolveAccess(fileId, false);
    if (!allowed) return errorResult(reason!);
    const drive = await getDrive();

    const res = await drive.comments.list({
      fileId,
      includeDeleted: false,
      pageSize: 100,
      pageToken: pageToken ?? undefined,
      fields:
        "nextPageToken, comments(id, content, author/displayName, createdTime, modifiedTime, resolved, quotedFileContent/value, replies(id, content, author/displayName, createdTime))",
    });

    const comments = (res.data.comments ?? [])
      .filter((comment) => includeResolved !== false || !comment.resolved)
      .map((comment) => ({
        id: comment.id ?? "",
        author: comment.author?.displayName ?? "",
        content: comment.content ?? "",
        quotedText: comment.quotedFileContent?.value ?? "",
        resolved: comment.resolved ?? false,
        createdTime: comment.createdTime ?? "",
        modifiedTime: comment.modifiedTime ?? "",
        replies: (comment.replies ?? []).map((reply) => ({
          id: reply.id ?? "",
          author: reply.author?.displayName ?? "",
          content: reply.content ?? "",
          createdTime: reply.createdTime ?? "",
        })),
      }));

    const result: Record<string, unknown> = { comments };
    if (res.data.nextPageToken) {
      result.nextPageToken = res.data.nextPageToken;
    }

    return comments.length > 0
      ? toonResult(result)
      : textResult("コメントが見つかりませんでした。");
  }
);

// 9. reply-comment
server.registerTool(
  "reply-comment",
  {
    description:
      "Google Docs のコメントに返信する。commentId は get-comments で取得する。allowlist で access: readwrite が付いたドキュメントのみ。",
    inputSchema: {
      fileId: z.string().describe("ドキュメントのファイルID"),
      commentId: z.string().describe("返信先コメントのID（get-commentsで取得）"),
      content: z.string().describe("返信内容"),
    },
  },
  async ({ fileId, commentId, content }: { fileId: string; commentId: string; content: string }) => {
    const { allowed, reason } = await resolveAccess(fileId, true);
    if (!allowed) return errorResult(reason!);

    const drive = await getDrive();
    const res = await drive.replies.create({
      fileId,
      commentId,
      requestBody: { content },
      fields: "id, content, createdTime",
    });
    return textResult(`コメントに返信しました (replyId: ${res.data.id})`);
  }
);

// 10. resolve-comment
server.registerTool(
  "resolve-comment",
  {
    description:
      "Google Docs のコメントを解決済みにする（任意で返信コメントを添える）。commentId は get-comments で取得する。allowlist で access: readwrite が付いたドキュメントのみ。",
    inputSchema: {
      fileId: z.string().describe("ドキュメントのファイルID"),
      commentId: z.string().describe("解決するコメントのID（get-commentsで取得）"),
      content: z.string().optional().describe("解決時に添える返信内容（省略可）"),
    },
  },
  async ({ fileId, commentId, content }: { fileId: string; commentId: string; content?: string }) => {
    const { allowed, reason } = await resolveAccess(fileId, true);
    if (!allowed) return errorResult(reason!);

    const drive = await getDrive();
    const res = await drive.replies.create({
      fileId,
      commentId,
      requestBody: { action: "resolve", ...(content ? { content } : {}) },
      fields: "id, action",
    });
    return textResult(`コメントを解決済みにしました (replyId: ${res.data.id})`);
  }
);

// 11. export-pdf
server.registerTool(
  "export-pdf",
  {
    description:
      "Google Docs をPDFに変換してローカルに保存する。allowlist に登録されたドキュメント（readonly可）のみ。",
    inputSchema: {
      fileId: z.string().describe("ドキュメントのファイルID"),
      savePath: z.string().describe("保存先の絶対パス（例: /Users/xxx/Desktop/doc.pdf）"),
    },
  },
  async ({ fileId, savePath }: { fileId: string; savePath: string }) => {
    const { allowed, reason } = await resolveAccess(fileId, false);
    if (!allowed) return errorResult(reason!);

    const drive = await getDrive();
    const res = await drive.files.export(
      { fileId, mimeType: "application/pdf" },
      { responseType: "arraybuffer" }
    );
    const buf = Buffer.from(res.data as ArrayBuffer);
    await mkdir(dirname(savePath), { recursive: true });
    await writeFile(savePath, buf);
    return textResult(`PDFを保存しました: ${savePath} (${buf.length.toLocaleString()} bytes)`);
  }
);
}

// 単体起動(bin / .claude.json から直接実行)用ブートストラップ。
// 統合エントリ (packages/all) からの import 時には走らないよう main-module ガードを置く。
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const server = new McpServer({ name: "google-docs", version: "1.2.0" });
  register(server);
  await server.connect(new StdioServerTransport());
}
