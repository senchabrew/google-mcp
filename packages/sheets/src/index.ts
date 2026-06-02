#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { encode } from "@toon-format/toon";
import { authorize, resolvePath } from "@shivaduke28/google-mcp-auth";
import { drive as googleDrive } from "@googleapis/drive";
import { sheets as googleSheets } from "@googleapis/sheets";
import { loadConfigs, checkAccess } from "./permissions.js";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

const rawCredentialsPath = process.env.GOOGLE_OAUTH_CREDENTIALS;
const configPath = process.env.GOOGLE_MCP_CONFIG ? resolvePath(process.env.GOOGLE_MCP_CONFIG) : undefined;

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
const resolvedTokensPath: string = process.env.GOOGLE_OAUTH_TOKENS ? resolvePath(process.env.GOOGLE_OAUTH_TOKENS) : join(homedir(), ".config", "google-sheets-mcp", "tokens.json");

// パーミッション設定 (own + common)
const { permission: permConfig, common: commonConfig } = await loadConfigs(configPath);

// lazy auth: ツール呼び出し時に初めて認証する
let sheetsClient: ReturnType<typeof googleSheets> | null = null;
let driveClient: ReturnType<typeof googleDrive> | null = null;

async function ensureAuth() {
  if (sheetsClient && driveClient) return { sheets: sheetsClient, drive: driveClient };
  const auth = await authorize(resolvedCredentialsPath, resolvedTokensPath, SCOPES);
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

const server = new McpServer({
  name: "google-sheets-mcp",
  version: "2.0.0",
});

// 1. list-spreadsheets
server.registerTool(
  "list-spreadsheets",
  {
    description: "allowlistに登録されたスプレッドシート一覧を返す。レスポンスはTOON形式で返す。",
    inputSchema: {},
  },
  async () => {
    if (!permConfig && !commonConfig) {
      return {
        content: [{
          type: "text",
          text: "allowlistが設定されていません。GOOGLE_MCP_CONFIG 環境変数で設定ファイルを指定してください。",
        }],
      };
    }

    const directRows = (permConfig?.allowedSpreadsheets ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      via: "direct",
    }));

    const folderRows = (commonConfig?.allowedFolders ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      via: "folder",
    }));

    const rows = [...directRows, ...folderRows];

    return {
      content: [{
        type: "text",
        text: rows.length > 0
          ? encode({ spreadsheets: rows })
          : "allowlistにスプレッドシート/フォルダが登録されていません。",
      }],
    };
  }
);

// 2. get-spreadsheet
server.registerTool(
  "get-spreadsheet",
  {
    description: "スプレッドシートのメタデータ（シート名一覧など）を取得する。レスポンスはTOON形式で返す。",
    inputSchema: {
      spreadsheetId: z.string().describe("スプレッドシートID"),
    },
  },
  async ({ spreadsheetId }) => {
    const drive = commonConfig?.allowedFolders?.length ? await getDrive() : null;
    const { allowed, reason } = await checkAccess(permConfig, commonConfig, drive, spreadsheetId, false);
    if (!allowed) {
      return { content: [{ type: "text", text: reason! }], isError: true };
    }

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.get({ spreadsheetId });

    const sheetList = (res.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title: s.properties?.title ?? "",
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    }));

    return {
      content: [{
        type: "text",
        text: encode({
          title: res.data.properties?.title ?? "",
          spreadsheetId: res.data.spreadsheetId ?? "",
          sheets: sheetList,
        }),
      }],
    };
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
    const drive = commonConfig?.allowedFolders?.length ? await getDrive() : null;
    const { allowed, reason } = await checkAccess(permConfig, commonConfig, drive, spreadsheetId, false);
    if (!allowed) {
      return { content: [{ type: "text", text: reason! }], isError: true };
    }

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });

    const values = res.data.values ?? [];
    if (values.length === 0) {
      return {
        content: [{ type: "text", text: "データが見つかりませんでした。" }],
      };
    }

    return {
      content: [{
        type: "text",
        text: encode({ range: res.data.range ?? range, values }),
      }],
    };
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
    const drive = commonConfig?.allowedFolders?.length ? await getDrive() : null;
    const { allowed, reason } = await checkAccess(permConfig, commonConfig, drive, spreadsheetId, true);
    if (!allowed) {
      return { content: [{ type: "text", text: reason! }], isError: true };
    }

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    return {
      content: [{
        type: "text",
        text: `${res.data.updatedCells ?? 0}セルを更新しました（範囲: ${res.data.updatedRange ?? range}）。`,
      }],
    };
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
    const drive = commonConfig?.allowedFolders?.length ? await getDrive() : null;
    const { allowed, reason } = await checkAccess(permConfig, commonConfig, drive, spreadsheetId, true);
    if (!allowed) {
      return { content: [{ type: "text", text: reason! }], isError: true };
    }

    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });

    return {
      content: [{
        type: "text",
        text: `${res.data.updates?.updatedRows ?? 0}行を追記しました（範囲: ${res.data.updates?.updatedRange ?? range}）。`,
      }],
    };
  }
);

// 6. create-from-template
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
    const drive = await getDrive();
    const tplCheck = await checkAccess(permConfig, commonConfig, drive, templateSpreadsheetId, false);
    if (!tplCheck.allowed) {
      return {
        content: [
          {
            type: "text",
            text: `テンプレへのアクセスが許可されていません: ${tplCheck.reason}`,
          },
        ],
        isError: true,
      };
    }

    // 2. Drive API でコピー
    const requestBody: { name: string; parents?: string[] } = { name: newName };
    if (parentFolderId) requestBody.parents = [parentFolderId];

    const copyRes = await drive.files.copy({
      fileId: templateSpreadsheetId,
      requestBody,
      supportsAllDrives: true,
    });
    const newId = copyRes.data.id;
    if (!newId) {
      return {
        content: [{ type: "text", text: "コピー後の Spreadsheet ID 取得に失敗しました。" }],
        isError: true,
      };
    }
    const webViewLink = `https://docs.google.com/spreadsheets/d/${newId}/edit`;

    // 3. config.json に書き戻し (永続化)
    let configWritten = false;
    if (configPath) {
      try {
        const content = await readFile(configPath, "utf-8");
        const config = JSON.parse(content) as Record<string, unknown>;
        const sheetsSection = (config.sheets ?? {}) as {
          allowedSpreadsheets?: Array<{ id: string; name: string; access?: string }>;
        };
        sheetsSection.allowedSpreadsheets = sheetsSection.allowedSpreadsheets ?? [];
        sheetsSection.allowedSpreadsheets.push({
          id: newId,
          name: newName,
          access: "readwrite",
        });
        config.sheets = sheetsSection;
        await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        configWritten = true;
      } catch (e) {
        console.error(`config.json 書き戻し失敗: ${e}`);
      }
    }

    // 4. in-memory permConfig にも push (即時反映)
    if (permConfig) {
      permConfig.allowedSpreadsheets.push({
        id: newId,
        name: newName,
        access: "readwrite",
      });
    } else if (!configPath) {
      // config 未設定でも今プロセス内では使えるように一時 entry を持たせる
      // (loadConfigs が null を返した場合は permConfig 自体が null なので push 不可)
    }

    const persistedNote = configWritten
      ? "config.json に永続化済み"
      : configPath
        ? "config.json 永続化に失敗、メモリ上のみ"
        : "GOOGLE_MCP_CONFIG 未設定のため永続化されず";

    return {
      content: [
        {
          type: "text",
          text: `Spreadsheet「${newName}」を作成しました。\n  id: ${newId}\n  url: ${webViewLink}\n  allowlist: access: readwrite で登録済み (${persistedNote})`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
