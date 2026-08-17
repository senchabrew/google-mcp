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
