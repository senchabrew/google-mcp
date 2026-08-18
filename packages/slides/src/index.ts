import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { encode } from "@toon-format/toon";
import {
  authorize,
  resolveServiceEnv,
  textResult,
  errorResult,
} from "@senchabrew/google-mcp-auth";
import { drive as googleDrive } from "@googleapis/drive";
import { slides as googleSlides } from "@googleapis/slides";
import type { slides_v1 } from "@googleapis/slides";
import { loadConfigs, checkAccess, checkFolderAccess } from "./permissions.js";
import { createReadStream, existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";

const GOOGLE_SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const { scopes, credentialsPath, tokensPath, configPath } = resolveServiceEnv(
  "google-slides-mcp",
  [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive",
  ]
);

// パーミッション設定は tool 呼び出しごとに loadConfigs() で最新を取得する
// (config.json を外部から変更しても即座に反映される)

// lazy auth: ツール呼び出し時に初めて認証する。drive / slides は同一 auth を共有する
let authClient: Awaited<ReturnType<typeof authorize>> | null = null;
let driveClient: ReturnType<typeof googleDrive> | null = null;
let slidesClient: ReturnType<typeof googleSlides> | null = null;

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

async function getSlides() {
  if (!slidesClient) {
    slidesClient = googleSlides({ version: "v1", auth: await getAuth() });
  }
  return slidesClient;
}

/** tool 呼び出しごとに最新権限を取得 */
async function resolveAccess(fileId: string, requireWrite: boolean) {
  const { permission, common } = await loadConfigs(configPath);
  const drive = common?.allowedFolders?.length ? await getDrive() : null;
  const check = await checkAccess(permission, common, drive, fileId, requireWrite);
  return { ...check, permission, common };
}

/** 新規プレゼンを config.json の slides.allowedPresentations に readwrite で永続化する */
async function persistToAllowlist(id: string, name: string): Promise<string> {
  if (!configPath) return "GOOGLE_MCP_CONFIG 未設定のため永続化されず";
  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content) as Record<string, unknown>;
    const slidesSection = (config.slides ?? {}) as {
      allowedPresentations?: Array<{ id: string; name: string; access?: string }>;
    };
    slidesSection.allowedPresentations = slidesSection.allowedPresentations ?? [];
    slidesSection.allowedPresentations.push({ id, name, access: "readwrite" });
    config.slides = slidesSection;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return "config.json に永続化済み";
  } catch (e) {
    console.error(`config.json 書き戻し失敗: ${e}`);
    return "config.json 永続化に失敗";
  }
}

/** pageElements を再帰的に走査してテキストを抽出する */
function extractTextFromElements(
  elements: slides_v1.Schema$PageElement[] | undefined
): string {
  if (!elements) return "";
  const parts: string[] = [];

  for (const el of elements) {
    // shape 内のテキスト
    const textElements = el.shape?.text?.textElements;
    if (textElements) {
      for (const te of textElements) {
        const content = te.textRun?.content;
        if (content) parts.push(content);
      }
    }

    // table セル内のテキスト
    const rows = el.table?.tableRows;
    if (rows) {
      for (const row of rows) {
        for (const cell of row.tableCells ?? []) {
          for (const te of cell.text?.textElements ?? []) {
            const content = te.textRun?.content;
            if (content) parts.push(content);
          }
        }
      }
    }

    // group 内を再帰
    if (el.elementGroup?.children) {
      const nested = extractTextFromElements(el.elementGroup.children);
      if (nested) parts.push(nested);
    }
  }

  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/** スピーカーノートのテキストを抽出する */
function extractNotes(slide: slides_v1.Schema$Page): string {
  const notesElements =
    slide.slideProperties?.notesPage?.pageElements ?? undefined;
  return extractTextFromElements(notesElements);
}

export function register(server: McpServer) {
// 1. list-presentations
server.registerTool(
  "list-presentations",
  {
    description:
      "allowlist に登録されたプレゼンテーションと共通フォルダの一覧を返す。レスポンスは TOON 形式で返す。",
    inputSchema: {},
  },
  async () => {
    const { permission, common } = await loadConfigs(configPath);
    if (!permission && !common) {
      return {
        content: [
          {
            type: "text" as const,
            text: "allowlist が設定されていません。GOOGLE_MCP_CONFIG 環境変数で設定ファイルを指定してください。",
          },
        ],
      };
    }

    const presentations = (permission?.allowedPresentations ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      type: "presentation",
    }));

    const folders = (common?.allowedFolders ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      type: "folder",
    }));

    const items = [...presentations, ...folders];

    return {
      content: [
        {
          type: "text" as const,
          text:
            items.length > 0
              ? encode({ allowedItems: items })
              : "allowlist にプレゼンテーション/フォルダが登録されていません。",
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
      "許可されたフォルダ内の Google Slides ファイル一覧を取得する。allowedFolders に直接登録されたフォルダ、またはその子孫フォルダのみ。レスポンスは TOON 形式で返す。",
    inputSchema: {
      folderId: z.string().describe("フォルダID"),
      pageToken: z
        .string()
        .optional()
        .describe("次ページのトークン（ページネーション用）"),
    },
  },
  async ({ folderId, pageToken }) => {
    const { common } = await loadConfigs(configPath);
    const drive = await getDrive();
    const { allowed, reason } = await checkFolderAccess(common, drive, folderId);
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }

    const res = await drive.files.list({
      q: `'${folderId}' in parents and (mimeType = '${GOOGLE_SLIDES_MIME_TYPE}' or mimeType = '${GOOGLE_FOLDER_MIME_TYPE}') and trashed = false`,
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
      type: file.mimeType === GOOGLE_FOLDER_MIME_TYPE ? "folder" : "presentation",
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
              : "フォルダ内に Google Slides が見つかりませんでした。",
        },
      ],
    };
  }
);

// 3. read-presentation
server.registerTool(
  "read-presentation",
  {
    description:
      "Google Slides の内容をスライド単位で取得する。各スライドの本文テキストとスピーカーノートを抽出して返す。allowlist に登録されたプレゼンテーション、または共通 allowedFolders 配下のプレゼンテーションのみ読み取り可能。",
    inputSchema: {
      fileId: z
        .string()
        .describe(
          "プレゼンテーションのファイルID（Google SlidesのURLの /d/XXXXX/ 部分）"
        ),
      includeNotes: z
        .boolean()
        .optional()
        .default(true)
        .describe("スピーカーノートを含めるか（デフォルト true）"),
    },
  },
  async ({ fileId, includeNotes }) => {
    const { allowed, reason } = await resolveAccess(fileId, false);
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }
    const drive = await getDrive();

    // mime type 確認
    const meta = await drive.files.get({
      fileId,
      fields: "id, name, mimeType, modifiedTime, lastModifyingUser/displayName",
      supportsAllDrives: true,
    });

    if (meta.data.mimeType !== GOOGLE_SLIDES_MIME_TYPE) {
      return {
        content: [
          {
            type: "text" as const,
            text: `指定されたファイルは Google Slides ではありません (mimeType: ${meta.data.mimeType})。`,
          },
        ],
        isError: true,
      };
    }

    // Slides API でプレゼンテーション構造を取得
    const slides = await getSlides();
    const pres = await slides.presentations.get({ presentationId: fileId });

    const slideList = (pres.data.slides ?? []).map((slide, index) => {
      const entry: Record<string, unknown> = {
        slideNumber: index + 1,
        text: extractTextFromElements(slide.pageElements ?? undefined),
      };
      if (includeNotes) {
        const notes = extractNotes(slide);
        if (notes) entry.notes = notes;
      }
      return entry;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: encode({
            presentation: {
              id: meta.data.id ?? fileId,
              name: meta.data.name ?? pres.data.title ?? "",
              modifiedTime: meta.data.modifiedTime ?? "",
              lastModifiedBy: meta.data.lastModifyingUser?.displayName ?? "",
              slideCount: slideList.length,
              slides: slideList,
            },
          }),
        },
      ],
    };
  }
);

// 3.5. get-raw-structure（table の objectId / セル位置を調べるための read-only ツール）
server.registerTool(
  "get-raw-structure",
  {
    description:
      "指定した1スライドの pageElements 生構造(objectId, table の行列数・各セルの rowIndex/columnIndex とテキスト)を返す。batch-update で table セルを直接編集する際に objectId を特定するために使う。read-only。",
    inputSchema: {
      fileId: z.string().describe("プレゼンテーションのファイルID"),
      slideNumber: z
        .number()
        .describe("対象スライド番号（1始まり、read-presentation の slideNumber と対応）"),
    },
  },
  async ({ fileId, slideNumber }) => {
    const { allowed, reason } = await resolveAccess(fileId, false);
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }
    const slides = await getSlides();
    const pres = await slides.presentations.get({ presentationId: fileId });
    const slide = (pres.data.slides ?? [])[slideNumber - 1];
    if (!slide) {
      return {
        content: [{ type: "text" as const, text: `slideNumber ${slideNumber} が見つかりません（全 ${pres.data.slides?.length ?? 0} スライド）。` }],
        isError: true,
      };
    }

    const elements = (slide.pageElements ?? []).map((el) => {
      const base: Record<string, unknown> = {
        objectId: el.objectId,
        type: el.table ? "table" : el.shape ? "shape" : el.elementGroup ? "group" : "other",
      };
      if (el.size && el.transform) {
        base.position = {
          xPt: Math.round((el.transform.translateX ?? 0) * (el.transform.unit === "EMU" ? 1 / 12700 : 1)),
          yPt: Math.round((el.transform.translateY ?? 0) * (el.transform.unit === "EMU" ? 1 / 12700 : 1)),
          widthPt: Math.round((el.size.width?.magnitude ?? 0) * (el.size.width?.unit === "EMU" ? 1 / 12700 : 1)),
          heightPt: Math.round((el.size.height?.magnitude ?? 0) * (el.size.height?.unit === "EMU" ? 1 / 12700 : 1)),
        };
      }
      if (el.table) {
        base.rows = el.table.rows;
        base.columns = el.table.columns;
        base.cells = (el.table.tableRows ?? []).flatMap((row, rowIndex) =>
          (row.tableCells ?? []).map((cell, columnIndex) => ({
            rowIndex,
            columnIndex,
            text: (cell.text?.textElements ?? [])
              .map((te) => te.textRun?.content ?? "")
              .join("")
              .trim(),
          }))
        );
      } else if (el.shape) {
        base.text = (el.shape.text?.textElements ?? [])
          .map((te) => te.textRun?.content ?? "")
          .join("")
          .trim();
        const firstRun = (el.shape.text?.textElements ?? []).find(
          (te) => te.textRun?.content?.trim()
        )?.textRun;
        if (firstRun?.style) {
          const s = firstRun.style;
          base.textStyle = {
            fontFamily: s.fontFamily,
            fontSizePt: s.fontSize?.magnitude,
            bold: s.bold,
            color: s.foregroundColor?.opaqueColor?.rgbColor,
          };
        }
        const bg = el.shape.shapeProperties?.shapeBackgroundFill?.solidFill?.color?.rgbColor;
        if (bg) base.fillColor = bg;
        const outline = el.shape.shapeProperties?.outline;
        if (outline?.outlineFill?.solidFill?.color?.rgbColor) {
          base.outlineColor = outline.outlineFill.solidFill.color.rgbColor;
        }
      }
      return base;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: encode({
            slideNumber,
            pageObjectId: slide.objectId,
            pageSizePt: pres.data.pageSize
              ? {
                  widthPt: Math.round((pres.data.pageSize.width?.magnitude ?? 0) / 12700),
                  heightPt: Math.round((pres.data.pageSize.height?.magnitude ?? 0) / 12700),
                }
              : undefined,
            elements,
          }),
        },
      ],
    };
  }
);

// 3.6. get-slide-thumbnail（実際のレンダリング結果を画像URLで確認する read-only ツール）
server.registerTool(
  "get-slide-thumbnail",
  {
    description:
      "指定した1スライドのサムネイル画像URL(PNG、数分で失効)を返す。batch-update 後に実際のレイアウト・配色が意図通りか目視確認するために使う。read-only。",
    inputSchema: {
      fileId: z.string().describe("プレゼンテーションのファイルID"),
      slideNumber: z
        .number()
        .describe("対象スライド番号（1始まり、read-presentation の slideNumber と対応）"),
    },
  },
  async ({ fileId, slideNumber }) => {
    const { allowed, reason } = await resolveAccess(fileId, false);
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }
    const slides = await getSlides();
    const pres = await slides.presentations.get({ presentationId: fileId });
    const slide = (pres.data.slides ?? [])[slideNumber - 1];
    if (!slide || !slide.objectId) {
      return {
        content: [{ type: "text" as const, text: `slideNumber ${slideNumber} が見つかりません。` }],
        isError: true,
      };
    }
    const thumb = await slides.presentations.pages.getThumbnail({
      presentationId: fileId,
      pageObjectId: slide.objectId,
      "thumbnailProperties.thumbnailSize": "LARGE",
    });
    return {
      content: [
        {
          type: "text" as const,
          text: encode({ slideNumber, thumbnailUrl: thumb.data.contentUrl }),
        },
      ],
    };
  }
);

// 4. search-presentations
server.registerTool(
  "search-presentations",
  {
    description:
      "許可された共通 allowedFolders 内の Google Slides をファイル名で検索する。allowedPresentations も名前一致で含む。レスポンスは TOON 形式で返す。",
    inputSchema: {
      query: z
        .string()
        .describe("検索キーワード（ファイル名に対する部分一致検索）"),
    },
  },
  async ({ query }) => {
    const { permission, common } = await loadConfigs(configPath);
    if (!permission && !common) {
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
    const { getAllSubfolderIds } = await import("@senchabrew/google-mcp-auth");
    for (const folder of common?.allowedFolders ?? []) {
      const subfolderIds = await getAllSubfolderIds(drive, folder.id);
      const folderIdsToSearch = [folder.id, ...subfolderIds];

      for (const searchFolderId of folderIdsToSearch) {
        const escapedQuery = query.replace(/'/g, "\\'");
        const res = await drive.files.list({
          q: `'${searchFolderId}' in parents and mimeType = '${GOOGLE_SLIDES_MIME_TYPE}' and name contains '${escapedQuery}' and trashed = false`,
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

    // allowedPresentations も名前でフィルタ
    const lowerQuery = query.toLowerCase();
    const matchedPresentations = (permission?.allowedPresentations ?? [])
      .filter((p) => p.name.toLowerCase().includes(lowerQuery))
      .map((p) => ({
        id: p.id,
        name: p.name,
        modifiedTime: "",
        lastModifiedBy: "",
        folder: "(直接登録)",
      }));

    const results = [...allFiles, ...matchedPresentations];

    return {
      content: [
        {
          type: "text" as const,
          text:
            results.length > 0
              ? encode({ results })
              : `「${query}」に一致するプレゼンテーションが見つかりませんでした。`,
        },
      ],
    };
  }
);

// 5. create-presentation
server.registerTool(
  "create-presentation",
  {
    description:
      "空の Google Slides を新規作成し、自動で allowlist に access: readwrite として登録する。作成後は MCP 再起動なしで read/write 可能。",
    inputSchema: {
      title: z.string().describe("新規プレゼンテーションのタイトル"),
      parentFolderId: z
        .string()
        .optional()
        .describe("配置先フォルダ ID（省略時は Drive ルート）"),
    },
  },
  async ({ title, parentFolderId }) => {
    const slides = await getSlides();
    const created = await slides.presentations.create({
      requestBody: { title },
    });
    const newId = created.data.presentationId;
    if (!newId) {
      return {
        content: [
          {
            type: "text" as const,
            text: "作成後のプレゼンテーション ID 取得に失敗しました。",
          },
        ],
        isError: true,
      };
    }

    // presentations.create は Drive ルートに作成するため、指定があれば移動する
    if (parentFolderId) {
      const drive = await getDrive();
      const cur = await drive.files.get({
        fileId: newId,
        fields: "parents",
        supportsAllDrives: true,
      });
      const prevParents = (cur.data.parents ?? []).join(",");
      await drive.files.update({
        fileId: newId,
        addParents: parentFolderId,
        removeParents: prevParents || undefined,
        supportsAllDrives: true,
      });
    }

    const note = await persistToAllowlist(newId, title);
    const url = `https://docs.google.com/presentation/d/${newId}/edit`;
    return {
      content: [
        {
          type: "text" as const,
          text: `プレゼンテーション「${title}」を作成しました。\n  id: ${newId}\n  url: ${url}\n  allowlist: access: readwrite で登録済み (${note})`,
        },
      ],
    };
  }
);

// 6. create-from-template
server.registerTool(
  "create-from-template",
  {
    description:
      "テンプレ Slides をコピーして新規 Slides を作成し、自動で allowlist に access: readwrite として登録する。テンプレ自身が allowlist に登録されている必要がある (readonly でも可)。作成後は MCP 再起動なしで read/write 可能。",
    inputSchema: {
      templatePresentationId: z
        .string()
        .describe("コピー元テンプレの Presentation ID"),
      newName: z.string().describe("新規 Slides の名前"),
      parentFolderId: z
        .string()
        .optional()
        .describe("配置先フォルダ ID（省略時は Drive ルート）"),
    },
  },
  async ({ templatePresentationId, newName, parentFolderId }) => {
    // テンプレへの read access チェック
    const tplCheck = await resolveAccess(templatePresentationId, false);
    if (!tplCheck.allowed) {
      return {
        content: [
          {
            type: "text" as const,
            text: `テンプレへのアクセスが許可されていません: ${tplCheck.reason}`,
          },
        ],
        isError: true,
      };
    }

    const drive = await getDrive();
    const requestBody: { name: string; parents?: string[] } = { name: newName };
    if (parentFolderId) requestBody.parents = [parentFolderId];

    const copyRes = await drive.files.copy({
      fileId: templatePresentationId,
      requestBody,
      supportsAllDrives: true,
    });
    const newId = copyRes.data.id;
    if (!newId) {
      return {
        content: [
          {
            type: "text" as const,
            text: "コピー後の Presentation ID 取得に失敗しました。",
          },
        ],
        isError: true,
      };
    }

    const note = await persistToAllowlist(newId, newName);
    const url = `https://docs.google.com/presentation/d/${newId}/edit`;
    return {
      content: [
        {
          type: "text" as const,
          text: `Slides「${newName}」を作成しました。\n  id: ${newId}\n  url: ${url}\n  allowlist: access: readwrite で登録済み (${note})`,
        },
      ],
    };
  }
);

// 7. replace-text
server.registerTool(
  "replace-text",
  {
    description:
      "プレゼンテーション内のテキストを一括置換する（batchUpdate replaceAllText）。テンプレの {{placeholder}} 置換などに使う。access: readwrite のプレゼンテーションのみ。",
    inputSchema: {
      fileId: z.string().describe("プレゼンテーションのファイルID"),
      replacements: z
        .array(
          z.object({
            find: z.string().describe("置換対象のテキスト"),
            replace: z.string().describe("置換後のテキスト"),
            matchCase: z
              .boolean()
              .optional()
              .default(true)
              .describe("大文字小文字を区別するか（デフォルト true）"),
          })
        )
        .describe("置換ペアの配列"),
    },
  },
  async ({ fileId, replacements }) => {
    const { allowed, reason } = await resolveAccess(fileId, true);
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }

    const slides = await getSlides();
    const requests = replacements.map((r) => ({
      replaceAllText: {
        containsText: { text: r.find, matchCase: r.matchCase },
        replaceText: r.replace,
      },
    }));
    const res = await slides.presentations.batchUpdate({
      presentationId: fileId,
      requestBody: { requests },
    });

    const replies = res.data.replies ?? [];
    const totalChanged = replies.reduce(
      (sum, rep) => sum + (rep.replaceAllText?.occurrencesChanged ?? 0),
      0
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `テキストを置換しました（合計 ${totalChanged} 箇所）。`,
        },
      ],
    };
  }
);

// 8. batch-update
server.registerTool(
  "batch-update",
  {
    description:
      "Slides API の presentations.batchUpdate を任意のリクエスト配列で実行する。スライド追加・図形/画像挿入・スタイル変更など全操作が可能。リクエスト形式は Slides API の Request スキーマに従う。access: readwrite のプレゼンテーションのみ。",
    inputSchema: {
      fileId: z.string().describe("プレゼンテーションのファイルID"),
      requests: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          "Slides API の Request オブジェクト配列（例: [{ createSlide: {...} }, { insertText: {...} }]）"
        ),
    },
  },
  async ({ fileId, requests }) => {
    const { allowed, reason } = await resolveAccess(fileId, true);
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }

    const slides = await getSlides();
    const res = await slides.presentations.batchUpdate({
      presentationId: fileId,
      requestBody: { requests: requests as slides_v1.Schema$Request[] },
    });

    return {
      content: [
        {
          type: "text" as const,
          text: encode({
            applied: (res.data.replies ?? []).length,
            replies: res.data.replies ?? [],
          }),
        },
      ],
    };
  }
);

// export-pdf
server.registerTool(
  "export-pdf",
  {
    description:
      "プレゼンテーションをPDFに変換してローカルに保存する。allowlist に登録されたプレゼンテーション（readonly可）のみ。",
    inputSchema: {
      fileId: z.string().describe("プレゼンテーションのファイルID"),
      savePath: z.string().describe("保存先の絶対パス（例: /Users/xxx/Desktop/slides.pdf）"),
    },
  },
  async ({ fileId, savePath }) => {
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

// insert-image-from-file
server.registerTool(
  "insert-image-from-file",
  {
    description:
      "ローカルの画像ファイルをスライドに挿入する（Drive に一時アップロード→挿入→一時ファイル削除）。スクリーンショットの貼り付けなどに使う。位置・サイズ未指定時はページ左上に原寸で入るので、必要なら batch-update (updatePageElementTransform) で調整する。allowlist で access: readwrite が付いたプレゼンテーションのみ。",
    inputSchema: {
      fileId: z.string().describe("プレゼンテーションのファイルID"),
      pageObjectId: z.string().describe("挿入先スライドの objectId（read-presentation / get-raw-structure で取得）"),
      imagePath: z.string().describe("画像ファイルの絶対パス（png / jpeg / gif）"),
      widthPt: z.number().optional().describe("幅（ポイント。省略時は原寸）"),
      heightPt: z.number().optional().describe("高さ（ポイント。省略時は原寸）"),
      xPt: z.number().optional().describe("左上X座標（ポイント。省略時は0）"),
      yPt: z.number().optional().describe("左上Y座標（ポイント。省略時は0）"),
    },
  },
  async ({ fileId, pageObjectId, imagePath, widthPt, heightPt, xPt, yPt }) => {
    const { allowed, reason } = await resolveAccess(fileId, true);
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }

    const resolvedImagePath = imagePath.startsWith("~") ? imagePath.replace(/^~/, process.env.HOME ?? "") : imagePath;
    if (!existsSync(resolvedImagePath)) {
      return errorResult(`画像ファイルが見つかりません: ${resolvedImagePath}`);
    }
    const ext = extname(resolvedImagePath).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" }[ext];
    if (!mime) {
      return errorResult(`未対応の画像形式です (${ext})。png / jpeg / gif を使ってください。`);
    }

    const drive = await getDrive();
    // 1. Driveに一時アップロードし、リンクを知っている全員が読めるようにする (Slides APIが画像URLを取得するため)
    const uploaded = await drive.files.create({
      requestBody: { name: `slides-image-temp-${Date.now()}${ext}` },
      media: { mimeType: mime, body: createReadStream(resolvedImagePath) },
      fields: "id",
    });
    const tempId = uploaded.data.id!;
    try {
      await drive.permissions.create({
        fileId: tempId,
        requestBody: { type: "anyone", role: "reader" },
      });

      const elementProperties: slides_v1.Schema$PageElementProperties = { pageObjectId };
      if (widthPt !== undefined && heightPt !== undefined) {
        elementProperties.size = {
          width: { magnitude: widthPt, unit: "PT" },
          height: { magnitude: heightPt, unit: "PT" },
        };
      }
      if (xPt !== undefined || yPt !== undefined) {
        elementProperties.transform = {
          scaleX: 1,
          scaleY: 1,
          translateX: xPt ?? 0,
          translateY: yPt ?? 0,
          unit: "PT",
        };
      }

      const slides = await getSlides();
      const res = await slides.presentations.batchUpdate({
        presentationId: fileId,
        requestBody: {
          requests: [
            {
              createImage: {
                url: `https://drive.google.com/uc?export=download&id=${tempId}`,
                elementProperties,
              },
            },
          ],
        },
      });
      const objectId = res.data.replies?.[0]?.createImage?.objectId;
      return textResult(`画像を挿入しました (objectId: ${objectId ?? "?"})`);
    } finally {
      // Slidesは挿入時に画像データを取り込むため、一時ファイルは削除してよい
      await drive.files.delete({ fileId: tempId }).catch(() => {});
    }
  }
);
}

// standalone 起動用ブートストラップ（統合エントリ (packages/all) から register() のみ import される場合はこの下は実行されない）
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new McpServer({ name: "google-slides", version: "1.1.0" });
  register(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
