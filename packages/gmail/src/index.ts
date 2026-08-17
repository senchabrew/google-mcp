import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  authorize,
  resolveServiceEnv,
  resolvePath,
  textResult,
  toonResult,
  errorResult,
} from "@shivaduke28/google-mcp-auth";
import { gmail as googleGmail } from "@googleapis/gmail";
import {
  extractHeaders,
  extractBody,
  extractAttachmentParts,
  buildRawMessage,
  type DraftAttachment,
} from "./gmail.js";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const { scopes, credentialsPath, tokensPath } = resolveServiceEnv("gmail-mcp", [
  "https://www.googleapis.com/auth/gmail.modify",
]);

// lazy auth: ツール呼び出し時に初めて認証する
let gmailClient: ReturnType<typeof googleGmail> | null = null;

async function getGmail() {
  if (!gmailClient) {
    const auth = await authorize(credentialsPath, tokensPath, scopes);
    gmailClient = googleGmail({ version: "v1", auth });
  }
  return gmailClient;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function guessMimeType(filePath: string): string {
  return MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function register(server: McpServer) {
// 1. search-messages
server.registerTool(
  "search-messages",
  {
    description: "Gmail検索クエリでメール一覧を取得する。レスポンスはTOON形式で返す。",
    inputSchema: {
      query: z.string().describe("Gmail検索クエリ（例: from:user@example.com, subject:会議, is:unread など）"),
      maxResults: z.number().optional().default(20).describe("最大取得件数"),
    },
  },
  async ({ query, maxResults }) => {
    const gmail = await getGmail();
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
    });

    const messageIds = res.data.messages ?? [];
    if (messageIds.length === 0) {
      return textResult("メッセージが見つかりませんでした");
    }

    const details = await Promise.all(
      messageIds
        .filter((msg) => msg.id)
        .map((msg) =>
          gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
          })
        )
    );

    const rows = details.map((detail) => {
      const headers = extractHeaders(detail.data.payload?.headers);
      return {
        date: headers.date,
        from: headers.from,
        to: headers.to,
        cc: headers.cc,
        subject: headers.subject,
        snippet: detail.data.snippet ?? "",
        id: detail.data.id ?? "",
        threadId: detail.data.threadId ?? "",
        labels: (detail.data.labelIds ?? []).join(", "),
      };
    });

    return toonResult({ messages: rows });
  }
);

// 2. get-messages
server.registerTool(
  "get-messages",
  {
    description:
      "複数のメッセージIDで本文を含むメール詳細を一括取得する。添付ファイルがある場合は attachments にファイル名一覧が入る（保存は download-attachments を使う）。",
    inputSchema: {
      messageIds: z.array(z.string()).describe("メッセージIDの配列"),
    },
  },
  async ({ messageIds }) => {
    const gmail = await getGmail();
    const details = await Promise.all(
      messageIds.map((id) =>
        gmail.users.messages.get({
          userId: "me",
          id,
          format: "full",
        })
      )
    );

    const messages = details.map((detail) => {
      const headers = extractHeaders(detail.data.payload?.headers);
      const body = extractBody(detail.data.payload ?? undefined);
      const attachments = extractAttachmentParts(detail.data.payload ?? undefined);
      return {
        id: detail.data.id ?? "",
        threadId: detail.data.threadId ?? "",
        labels: (detail.data.labelIds ?? []).join(", "),
        date: headers.date,
        from: headers.from,
        to: headers.to,
        cc: headers.cc,
        subject: headers.subject,
        body,
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
              })),
            }
          : {}),
      };
    });

    return toonResult({ messages });
  }
);

// 3. get-threads
server.registerTool(
  "get-threads",
  {
    description: "複数のスレッドIDでスレッド全体のメッセージを一括取得する。",
    inputSchema: {
      threadIds: z.array(z.string()).describe("スレッドIDの配列"),
    },
  },
  async ({ threadIds }) => {
    const gmail = await getGmail();
    const threads = await Promise.all(
      threadIds.map((id) =>
        gmail.users.threads.get({
          userId: "me",
          id,
          format: "full",
        })
      )
    );

    const result = threads.map((thread) => {
      const messages = (thread.data.messages ?? []).map((msg) => {
        const headers = extractHeaders(msg.payload?.headers);
        const body = extractBody(msg.payload ?? undefined);
        return {
          id: msg.id ?? "",
          date: headers.date,
          from: headers.from,
          to: headers.to,
          cc: headers.cc,
          subject: headers.subject,
          labels: (msg.labelIds ?? []).join(", "),
          body,
        };
      });
      return {
        threadId: thread.data.id ?? "",
        messages,
      };
    });

    return toonResult({ threads: result });
  }
);

// 4. create-draft
server.registerTool(
  "create-draft",
  {
    description:
      "メールの下書きを作成する（送信はしない）。返信の場合はthreadIdとinReplyToMessageIdを指定する。添付はローカルファイルの絶対パスで指定する。",
    inputSchema: {
      to: z.array(z.string()).describe("宛先メールアドレスの配列"),
      cc: z.array(z.string()).optional().default([]).describe("CCメールアドレスの配列"),
      bcc: z.array(z.string()).optional().default([]).describe("BCCメールアドレスの配列"),
      subject: z.string().describe("件名"),
      body: z.string().describe("本文"),
      attachmentPaths: z
        .array(z.string())
        .optional()
        .default([])
        .describe("添付するローカルファイルの絶対パスの配列（合計25MBまで）"),
      threadId: z.string().optional().describe("返信先スレッドID（返信時に指定）"),
      inReplyToMessageId: z.string().optional().describe("返信先メッセージID（返信時に指定。Referencesヘッダー構築用）"),
    },
  },
  async ({ to, cc, bcc, subject, body, attachmentPaths, threadId, inReplyToMessageId }) => {
    const gmail = await getGmail();

    // 添付ファイルの読み込み
    const attachments: DraftAttachment[] = [];
    for (const rawPath of attachmentPaths) {
      const filePath = resolvePath(rawPath);
      if (!existsSync(filePath)) {
        return errorResult(`添付ファイルが見つかりません: ${filePath}`);
      }
      const content = await readFile(filePath);
      attachments.push({
        filename: basename(filePath),
        mimeType: guessMimeType(filePath),
        contentBase64: content.toString("base64"),
      });
    }
    const totalSize = attachments.reduce((sum, a) => sum + a.contentBase64.length, 0);
    if (totalSize > 25 * 1024 * 1024) {
      return errorResult("添付ファイルの合計サイズが25MBを超えています。");
    }

    // 返信時のヘッダー構築
    let inReplyTo: string | undefined;
    let references: string | undefined;

    if (inReplyToMessageId && threadId) {
      try {
        const origMsg = await gmail.users.messages.get({
          userId: "me",
          id: inReplyToMessageId,
          format: "metadata",
          metadataHeaders: ["Message-ID", "References"],
        });
        const origHeaders = origMsg.data.payload?.headers ?? [];
        const messageIdHeader = origHeaders.find((h) => h.name?.toLowerCase() === "message-id")?.value ?? "";
        const referencesHeader = origHeaders.find((h) => h.name?.toLowerCase() === "references")?.value ?? "";

        if (messageIdHeader) {
          inReplyTo = messageIdHeader;
          references = referencesHeader ? `${referencesHeader} ${messageIdHeader}` : messageIdHeader;
        }
      } catch {
        // 元メッセージの取得に失敗しても下書き作成は続行
      }
    }

    const raw = buildRawMessage({ to, cc, bcc, subject, body, inReplyTo, references, attachments });

    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          ...(threadId && { threadId }),
        },
      },
    });

    const attachmentNote =
      attachments.length > 0 ? `、添付 ${attachments.length} 件` : "";
    return textResult(`下書きを作成しました (ID: ${draft.data.id}${attachmentNote})`);
  }
);

// 5. download-attachments
server.registerTool(
  "download-attachments",
  {
    description:
      "メールの添付ファイルをローカルに保存する。添付の有無とファイル名は get-messages で確認できる。",
    inputSchema: {
      messageId: z.string().describe("メッセージID"),
      saveDir: z.string().describe("保存先ディレクトリの絶対パス"),
      filenames: z
        .array(z.string())
        .optional()
        .describe("保存する添付ファイル名の配列（省略時は全添付を保存）"),
    },
  },
  async ({ messageId, saveDir, filenames }) => {
    const gmail = await getGmail();
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    let parts = extractAttachmentParts(msg.data.payload ?? undefined);
    if (filenames && filenames.length > 0) {
      parts = parts.filter((p) => filenames.includes(p.filename));
    }
    if (parts.length === 0) {
      return textResult("保存対象の添付ファイルが見つかりませんでした。");
    }

    const dir = resolvePath(saveDir);
    await mkdir(dir, { recursive: true });

    const saved: Array<{ filename: string; path: string; size: number }> = [];
    for (const part of parts) {
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: part.attachmentId,
      });
      const data = att.data.data ?? "";
      const buf = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      // パス区切りを除去してディレクトリ外への書き込みを防ぐ
      const safeName = basename(part.filename);
      const savePath = join(dir, safeName);
      await writeFile(savePath, buf);
      saved.push({ filename: safeName, path: savePath, size: buf.length });
    }

    return toonResult({ saved });
  }
);

// 6. modify-labels
server.registerTool(
  "modify-labels",
  {
    description: "メッセージのラベルを追加/削除する。アーカイブはremoveLabelIdsに\"INBOX\"を指定する。",
    inputSchema: {
      messageIds: z.array(z.string()).describe("メッセージIDの配列"),
      addLabelIds: z.array(z.string()).optional().default([]).describe("追加するラベルIDの配列"),
      removeLabelIds: z.array(z.string()).optional().default([]).describe("削除するラベルIDの配列"),
    },
  },
  async ({ messageIds, addLabelIds, removeLabelIds }) => {
    const gmail = await getGmail();
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids: messageIds,
        addLabelIds,
        removeLabelIds,
      },
    });

    return textResult(`${messageIds.length}件のメッセージのラベルを更新しました。`);
  }
);

// 7. list-labels
server.registerTool(
  "list-labels",
  {
    description: "利用可能なラベル一覧を取得する。レスポンスはTOON形式で返す。",
    inputSchema: {},
  },
  async () => {
    const gmail = await getGmail();
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = (res.data.labels ?? []).map((label) => ({
      id: label.id ?? "",
      name: label.name ?? "",
      type: label.type ?? "",
    }));

    return toonResult({ labels });
  }
);
}
