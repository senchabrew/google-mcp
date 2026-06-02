#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { encode } from "@toon-format/toon";
import { authorize, resolvePath } from "@shivaduke28/google-mcp-auth";
import { drive as googleDrive } from "@googleapis/drive";
import { script as googleScript } from "@googleapis/script";
import { loadConfigs, checkAccess } from "./permissions.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCOPES = [
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/drive.readonly",
];

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
  : join(homedir(), ".config", "google-apps-script-mcp", "tokens.json");

const { permission: permConfig, common: commonConfig } = await loadConfigs(configPath);

let scriptClient: ReturnType<typeof googleScript> | null = null;
let driveClient: ReturnType<typeof googleDrive> | null = null;

async function ensureAuth() {
  if (scriptClient && driveClient) return { script: scriptClient, drive: driveClient };
  const auth = await authorize(resolvedCredentialsPath, resolvedTokensPath, SCOPES);
  scriptClient = scriptClient ?? googleScript({ version: "v1", auth });
  driveClient = driveClient ?? googleDrive({ version: "v3", auth });
  return { script: scriptClient, drive: driveClient };
}

async function getScript() {
  return (await ensureAuth()).script;
}

async function getDrive() {
  return (await ensureAuth()).drive;
}

const server = new McpServer({
  name: "google-apps-script-mcp",
  version: "1.0.0",
});

// 1. list-projects
server.registerTool(
  "list-projects",
  {
    description: "allowlistに登録されたApps Scriptプロジェクト一覧を返す。レスポンスはTOON形式で返す。",
    inputSchema: {},
  },
  async () => {
    if (!permConfig && !commonConfig) {
      return {
        content: [
          {
            type: "text" as const,
            text: "allowlistが設定されていません。GOOGLE_MCP_CONFIG 環境変数で設定ファイルを指定してください。",
          },
        ],
      };
    }

    const projects = (permConfig?.allowedProjects ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      via: "direct",
    }));

    const folders = (commonConfig?.allowedFolders ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      via: "folder",
    }));

    const items = [...projects, ...folders];

    return {
      content: [
        {
          type: "text" as const,
          text: items.length > 0
            ? encode({ allowedItems: items })
            : "allowlistにApps Scriptプロジェクト/フォルダが登録されていません。",
        },
      ],
    };
  }
);

// 2. get-project
server.registerTool(
  "get-project",
  {
    description: "Apps Scriptプロジェクトのメタデータを取得する。レスポンスはTOON形式で返す。",
    inputSchema: {
      scriptId: z.string().describe("Apps ScriptプロジェクトID"),
    },
  },
  async ({ scriptId }) => {
    const drive = commonConfig?.allowedFolders?.length ? await getDrive() : null;
    const { allowed, reason } = await checkAccess(permConfig, commonConfig, drive, scriptId, "readonly");
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }

    const script = await getScript();
    const res = await script.projects.get({ scriptId });

    return {
      content: [
        {
          type: "text" as const,
          text: encode({
            scriptId: res.data.scriptId ?? scriptId,
            title: res.data.title ?? "",
            createTime: res.data.createTime ?? "",
            updateTime: res.data.updateTime ?? "",
            parentId: res.data.parentId ?? "",
          }),
        },
      ],
    };
  }
);

// 3. get-content
server.registerTool(
  "get-content",
  {
    description: "Apps Scriptプロジェクトのソースファイル一覧と内容を取得する。レスポンスはTOON形式で返す。",
    inputSchema: {
      scriptId: z.string().describe("Apps ScriptプロジェクトID"),
    },
  },
  async ({ scriptId }) => {
    const drive = commonConfig?.allowedFolders?.length ? await getDrive() : null;
    const { allowed, reason } = await checkAccess(permConfig, commonConfig, drive, scriptId, "readonly");
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }

    const script = await getScript();
    const res = await script.projects.getContent({ scriptId });

    const files = (res.data.files ?? []).map((f) => ({
      name: f.name ?? "",
      type: f.type ?? "",
      source: f.source ?? "",
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: encode({
            scriptId: res.data.scriptId ?? scriptId,
            files,
          }),
        },
      ],
    };
  }
);

// 4. update-content
server.registerTool(
  "update-content",
  {
    description:
      "Apps Scriptプロジェクトのソースファイルを更新する。access: readwrite以上のプロジェクトのみ。注意: 指定したファイルでプロジェクト全体を置き換えます。既存ファイルを保持するには、get-contentで取得した全ファイルを含めてください。",
    inputSchema: {
      scriptId: z.string().describe("Apps ScriptプロジェクトID"),
      files: z
        .array(
          z.object({
            name: z.string().describe("ファイル名(拡張子なし)"),
            type: z.enum(["SERVER_JS", "HTML", "JSON"]).describe("ファイルタイプ"),
            source: z.string().describe("ファイルの内容"),
          })
        )
        .describe("更新するファイルの配列。プロジェクト全体をこの内容で置き換えます。"),
    },
  },
  async ({ scriptId, files }) => {
    const drive = commonConfig?.allowedFolders?.length ? await getDrive() : null;
    const { allowed, reason } = await checkAccess(permConfig, commonConfig, drive, scriptId, "readwrite");
    if (!allowed) {
      return { content: [{ type: "text" as const, text: reason! }], isError: true };
    }

    const script = await getScript();
    await script.projects.updateContent({
      scriptId,
      requestBody: { files },
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `プロジェクトを更新しました（${files.length}ファイル）。`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
