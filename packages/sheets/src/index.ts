import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  authorize,
  resolveServiceEnv,
  appendAllowlistEntry,
  textResult,
  toonResult,
  errorResult,
} from "@senchabrew/google-mcp-auth";
import { drive as googleDrive } from "@googleapis/drive";
import { sheets as googleSheets } from "@googleapis/sheets";
import type { sheets_v4 } from "@googleapis/sheets";
import { loadConfigs, checkAccess } from "./permissions.js";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { exec } from "node:child_process";

const { scopes, credentialsPath, tokensPath, configPath } = resolveServiceEnv(
  "google-sheets-mcp",
  [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ]
);

// パーミッション設定は tool 呼び出しごとに loadConfigs() を呼んで最新を取得する。
// (config.json を外部から変更しても即座に反映される)

// lazy auth: ツール呼び出し時に初めて認証する
let sheetsClient: ReturnType<typeof googleSheets> | null = null;
let driveClient: ReturnType<typeof googleDrive> | null = null;

async function ensureAuth() {
  if (sheetsClient && driveClient) return { sheets: sheetsClient, drive: driveClient };
  const auth = await authorize(credentialsPath, tokensPath, scopes);
  sheetsClient = sheetsClient ?? googleSheets({ version: "v4", auth });
  driveClient = driveClient ?? googleDrive({ version: "v3", auth });
  return { sheets: sheetsClient, drive: driveClient };
}

async function getSheets() {
  return (await ensureAuth()).sheets;
}

async function getDrive() {
  return (await ensureAuth()).drive;
}

/**
 * tool 呼び出しごとに config.json を再 load して最新権限を返す。
 * (config を外部から変更しても次の tool 呼び出しで即反映)
 */
async function resolveAccess(spreadsheetId: string, requireWrite: boolean) {
  const { permission, common } = await loadConfigs(configPath);
  const drive = common?.allowedFolders?.length ? await getDrive() : null;
  const check = await checkAccess(permission, common, drive, spreadsheetId, requireWrite);
  return { ...check, permission, common };
}

/** 新規作成した Spreadsheet を allowlist に readwrite 登録し、結果メッセージを返す */
async function registerToAllowlist(id: string, name: string): Promise<string> {
  const written = await appendAllowlistEntry(configPath, "sheets", "allowedSpreadsheets", {
    id,
    name,
    access: "readwrite",
  });
  return written
    ? "config.json に永続化済み"
    : configPath
      ? "config.json 永続化に失敗"
      : "GOOGLE_MCP_CONFIG 未設定のため永続化されず";
}

export function register(server: McpServer) {
// 1. list-spreadsheets
server.registerTool(
  "list-spreadsheets",
  {
    description: "allowlistに登録されたスプレッドシート一覧を返す。レスポンスはTOON形式で返す。",
    inputSchema: {},
  },
  async () => {
    const { permission, common } = await loadConfigs(configPath);
    if (!permission && !common) {
      return textResult(
        "allowlistが設定されていません。GOOGLE_MCP_CONFIG 環境変数で設定ファイルを指定してください。"
      );
    }

    const directRows = (permission?.allowedSpreadsheets ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      via: "direct",
    }));

    const folderRows = (common?.allowedFolders ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      via: "folder",
    }));

    const rows = [...directRows, ...folderRows];
    return rows.length > 0
      ? toonResult({ spreadsheets: rows })
      : textResult("allowlistにスプレッドシート/フォルダが登録されていません。");
  }
);

// 2. get-spreadsheet
server.registerTool(
  "get-spreadsheet",
  {
    description:
      "スプレッドシートのメタデータ（シート名・sheetId 一覧など）を取得する。レスポンスはTOON形式で返す。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
    },
  },
  async ({ spreadsheetId }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, false);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.get({ spreadsheetId });

    const sheetList = (res.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title: s.properties?.title ?? "",
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    }));

    return toonResult({
      title: res.data.properties?.title ?? "",
      spreadsheetId: res.data.spreadsheetId ?? "",
      sheets: sheetList,
    });
  }
);

// 3. get-values
server.registerTool(
  "get-values",
  {
    description: "指定範囲のセル値を取得する（A1表記: Sheet1!A1:D10）。レスポンスはTOON形式で返す。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      range: z.string().describe("取得範囲（A1表記。例: Sheet1!A1:D10）"),
    },
  },
  async ({ spreadsheetId, range }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, false);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });

    const values = res.data.values ?? [];
    if (values.length === 0) {
      return textResult("データが見つかりませんでした。");
    }

    return toonResult({ range: res.data.range ?? range, values });
  }
);

// 4. update-values
server.registerTool(
  "update-values",
  {
    description: "セル範囲に値を書き込む。access: readwrite のスプレッドシートのみ。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      range: z.string().describe("書き込み範囲（A1表記。例: Sheet1!A1:D10）"),
      values: z.array(z.array(z.string())).describe("書き込む値の2次元配列（行×列）"),
    },
  },
  async ({ spreadsheetId, range, values }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, true);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    return textResult(
      `${res.data.updatedCells ?? 0}セルを更新しました（範囲: ${res.data.updatedRange ?? range}）。`
    );
  }
);

// 5. append-values
server.registerTool(
  "append-values",
  {
    description: "テーブルの末尾に行を追記する。access: readwrite のスプレッドシートのみ。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      range: z.string().describe("追記先の範囲（A1表記。例: Sheet1!A:D）"),
      values: z.array(z.array(z.string())).describe("追記する値の2次元配列（行×列）"),
    },
  },
  async ({ spreadsheetId, range, values }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, true);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });

    return textResult(
      `${res.data.updates?.updatedRows ?? 0}行を追記しました（範囲: ${res.data.updates?.updatedRange ?? range}）。`
    );
  }
);

// 6. clear-values
server.registerTool(
  "clear-values",
  {
    description:
      "セル範囲の値をクリアする（書式は残る）。access: readwrite のスプレッドシートのみ。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      range: z.string().describe("クリアする範囲（A1表記。例: Sheet1!A2:D10）"),
    },
  },
  async ({ spreadsheetId, range }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, true);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.clear({ spreadsheetId, range });
    return textResult(`範囲をクリアしました（${res.data.clearedRange ?? range}）。`);
  }
);

// 7. delete-rows
server.registerTool(
  "delete-rows",
  {
    description:
      "指定シートの行を削除する（取り消し不可。以降の行は上に詰まる）。access: readwrite のスプレッドシートのみ。sheetId は get-spreadsheet で確認する。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      sheetId: z.number().int().describe("シートID（シート名ではなく数値ID。get-spreadsheetで取得）"),
      startRow: z.number().int().min(1).describe("削除開始行（1始まり、この行を含む）"),
      endRow: z.number().int().min(1).describe("削除終了行（1始まり、この行を含む）"),
    },
  },
  async ({ spreadsheetId, sheetId, startRow, endRow }) => {
    if (endRow < startRow) {
      return errorResult(`endRow (${endRow}) は startRow (${startRow}) 以上を指定してください。`);
    }
    const { allowed, reason } = await resolveAccess(spreadsheetId, true);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: startRow - 1,
                endIndex: endRow,
              },
            },
          },
        ],
      },
    });
    return textResult(`${startRow}〜${endRow}行目を削除しました（${endRow - startRow + 1}行）。`);
  }
);

// 8. add-sheet
server.registerTool(
  "add-sheet",
  {
    description:
      "スプレッドシートに新しいシート（タブ）を追加する。access: readwrite のスプレッドシートのみ。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      title: z.string().describe("新しいシートの名前"),
    },
  },
  async ({ spreadsheetId, title }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, true);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
    const added = res.data.replies?.[0]?.addSheet?.properties;
    return textResult(
      `シート「${added?.title ?? title}」を追加しました（sheetId: ${added?.sheetId}）。`
    );
  }
);

// 9. create-spreadsheet
server.registerTool(
  "create-spreadsheet",
  {
    description:
      "空の Spreadsheet を新規作成し、自動で allowlist に access: readwrite として登録する。作成後は MCP 再起動なしですぐに update-values 等で操作可能。",
    inputSchema: {
      title: z.string().describe("新規 Spreadsheet の名前"),
      parentFolderId: z
        .string()
        .optional()
        .describe("配置先フォルダ ID (省略時は Drive ルート)"),
    },
  },
  async ({ title, parentFolderId }) => {
    const sheets = await getSheets();
    const createRes = await sheets.spreadsheets.create({
      requestBody: { properties: { title } },
    });
    const newId = createRes.data.spreadsheetId;
    if (!newId) {
      return errorResult("作成後の Spreadsheet ID 取得に失敗しました。");
    }

    if (parentFolderId) {
      const drive = await getDrive();
      await drive.files.update({
        fileId: newId,
        addParents: parentFolderId,
        supportsAllDrives: true,
      });
    }

    const persistedNote = await registerToAllowlist(newId, title);
    return textResult(
      `Spreadsheet「${title}」を作成しました。\n  id: ${newId}\n  url: https://docs.google.com/spreadsheets/d/${newId}/edit\n  allowlist: access: readwrite で登録済み (${persistedNote})`
    );
  }
);

// 10. create-from-template
server.registerTool(
  "create-from-template",
  {
    description:
      "テンプレ Spreadsheet をコピーして新規 Spreadsheet を作成し、自動で allowlist に access: readwrite として登録する。テンプレ自身が allowlist に登録されている必要がある (readonly でも可)。作成後は MCP 再起動なしですぐに get-values / update-values で操作可能。",
    inputSchema: {
      templateSpreadsheetId: z.string().describe("コピー元テンプレの Spreadsheet ID"),
      newName: z.string().describe("新規 Spreadsheet の名前"),
      parentFolderId: z
        .string()
        .optional()
        .describe("新規 Spreadsheet の配置先フォルダ ID (省略時は Drive ルート)"),
    },
  },
  async ({ templateSpreadsheetId, newName, parentFolderId }) => {
    // 1. テンプレへの read access チェック
    const tplCheck = await resolveAccess(templateSpreadsheetId, false);
    if (!tplCheck.allowed) {
      return errorResult(`テンプレへのアクセスが許可されていません: ${tplCheck.reason}`);
    }

    // 2. Drive API でコピー
    const drive = await getDrive();
    const requestBody: { name: string; parents?: string[] } = { name: newName };
    if (parentFolderId) requestBody.parents = [parentFolderId];

    const copyRes = await drive.files.copy({
      fileId: templateSpreadsheetId,
      requestBody,
      supportsAllDrives: true,
    });
    const newId = copyRes.data.id;
    if (!newId) {
      return errorResult("コピー後の Spreadsheet ID 取得に失敗しました。");
    }

    const persistedNote = await registerToAllowlist(newId, newName);
    return textResult(
      `Spreadsheet「${newName}」を作成しました。\n  id: ${newId}\n  url: https://docs.google.com/spreadsheets/d/${newId}/edit\n  allowlist: access: readwrite で登録済み (${persistedNote})`
    );
  }
);

// 11. export-pdf
server.registerTool(
  "export-pdf",
  {
    description:
      "スプレッドシートをPDFに変換してローカルに保存する。allowlist に登録されたスプレッドシート（readonly可）のみ。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      savePath: z.string().describe("保存先の絶対パス（例: /Users/xxx/Desktop/report.pdf）"),
    },
  },
  async ({ spreadsheetId, savePath }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, false);
    if (!allowed) return errorResult(reason!);

    const drive = await getDrive();
    const res = await drive.files.export(
      { fileId: spreadsheetId, mimeType: "application/pdf" },
      { responseType: "arraybuffer" }
    );
    const buf = Buffer.from(res.data as ArrayBuffer);
    await mkdir(dirname(savePath), { recursive: true });
    await writeFile(savePath, buf);
    return textResult(`PDFを保存しました: ${savePath} (${buf.length.toLocaleString()} bytes)`);
  }
);

// 12. batch-get-values
server.registerTool(
  "batch-get-values",
  {
    description:
      "複数のセル範囲の値を1回のリクエストでまとめて取得する。レスポンスはTOON形式で返す。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      ranges: z.array(z.string()).min(1).describe("取得範囲の配列（A1表記。例: [\"Sheet1!A1:D10\", \"集計!B2:B20\"]）"),
    },
  },
  async ({ spreadsheetId, ranges }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, false);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
    const valueRanges = (res.data.valueRanges ?? []).map((vr) => ({
      range: vr.range ?? "",
      values: vr.values ?? [],
    }));
    return toonResult({ valueRanges });
  }
);

// 13. find-replace
server.registerTool(
  "find-replace",
  {
    description:
      "スプレッドシート内の文字列を一括置換する。access: readwrite のスプレッドシートのみ。sheetId 指定でそのシートのみ、省略時は全シートが対象。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      find: z.string().describe("検索文字列"),
      replacement: z.string().describe("置換後の文字列"),
      matchCase: z.boolean().optional().default(true).describe("大文字小文字を区別するか"),
      matchEntireCell: z.boolean().optional().default(false).describe("セル全体一致のみ置換するか"),
      sheetId: z.number().int().optional().describe("対象シートID（省略時は全シート。get-spreadsheetで取得）"),
    },
  },
  async ({ spreadsheetId, find, replacement, matchCase, matchEntireCell, sheetId }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, true);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            findReplace: {
              find,
              replacement,
              matchCase,
              matchEntireCell,
              ...(sheetId !== undefined ? { sheetId } : { allSheets: true }),
            },
          },
        ],
      },
    });
    const r = res.data.replies?.[0]?.findReplace;
    return textResult(
      `置換しました（値: ${r?.valuesChanged ?? 0}箇所、数式: ${r?.formulasChanged ?? 0}箇所、対象シート: ${r?.sheetsChanged ?? 0}）。`
    );
  }
);

// 14. copy-sheet-to-spreadsheet
server.registerTool(
  "copy-sheet-to-spreadsheet",
  {
    description:
      "シート（タブ）を別のスプレッドシートへ複製する。コピー元は readonly 可、コピー先は access: readwrite が必要。テンプレタブの配布に使える。",
    inputSchema: {
      spreadsheetId: z.string().describe("コピー元のスプレッドシートID"),
      sheetId: z.number().int().describe("コピーするシートID（get-spreadsheetで取得）"),
      destinationSpreadsheetId: z.string().describe("コピー先のスプレッドシートID"),
    },
  },
  async ({ spreadsheetId, sheetId, destinationSpreadsheetId }) => {
    const src = await resolveAccess(spreadsheetId, false);
    if (!src.allowed) return errorResult(`コピー元: ${src.reason}`);
    const dst = await resolveAccess(destinationSpreadsheetId, true);
    if (!dst.allowed) return errorResult(`コピー先: ${dst.reason}`);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.sheets.copyTo({
      spreadsheetId,
      sheetId,
      requestBody: { destinationSpreadsheetId },
    });
    return textResult(
      `シートをコピーしました（コピー先での名前: 「${res.data.title}」/ sheetId: ${res.data.sheetId}）。名前の変更は batch-update の updateSheetProperties で可能。`
    );
  }
);

// 15. batch-update
server.registerTool(
  "batch-update",
  {
    description:
      "Sheets API の spreadsheets.batchUpdate を任意のリクエスト配列で実行する。セル書式（太字・背景色・罫線・列幅）・シート名変更・シート複製・行列の固定・条件付き書式・フィルタなど、専用ツールが無い操作の汎用口。access: readwrite のスプレッドシートのみ。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
      requests: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          "Sheets API の Request オブジェクト配列（例: [{ repeatCell: {...} }, { updateSheetProperties: {...} }]）"
        ),
    },
  },
  async ({ spreadsheetId, requests }) => {
    const { allowed, reason } = await resolveAccess(spreadsheetId, true);
    if (!allowed) return errorResult(reason!);

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: requests as sheets_v4.Schema$Request[] },
    });
    return toonResult({
      applied: (res.data.replies ?? []).length,
      replies: res.data.replies ?? [],
    });
  }
);

// 許可リスト (config.json) を OS の既定アプリで開く。
// 無ければ空テンプレートで作成してから開く。編集→保存で次回ツール実行から反映。
server.registerTool(
  "open-allowlist",
  {
    title: "許可リストファイルを開く",
    description:
      "許可スプレッドシートの設定ファイル (config.json) を OS の既定アプリで開く。シートの追加・削除や読み取り/書き込み権限を編集して保存すると、次のツール実行から即反映される。",
    inputSchema: {},
  },
  async () => {
    if (!configPath) {
      return errorResult("GOOGLE_MCP_CONFIG が未設定のため開けません。");
    }
    if (!existsSync(configPath)) {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ sheets: { allowedSpreadsheets: [] } }, null, 2),
        { mode: 0o600 }
      );
    }
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? 'start ""'
          : "xdg-open";
    exec(`${opener} "${configPath}"`);
    return textResult(
      `設定ファイルを開きました:\n${configPath}\n\n編集して保存すると、次のツール実行から反映されます。`
    );
  }
);
}
