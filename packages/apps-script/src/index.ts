import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  authorize,
  resolveServiceEnv,
  textResult,
  toonResult,
  errorResult,
} from "@senchabrew/google-mcp-auth";
import { drive as googleDrive } from "@googleapis/drive";
import { script as googleScript } from "@googleapis/script";
import { loadConfigs, checkAccess } from "./permissions.js";

const { scopes, credentialsPath, tokensPath, configPath } = resolveServiceEnv(
  "google-apps-script-mcp",
  [
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.processes",
    "https://www.googleapis.com/auth/drive.readonly",
  ]
);

// パーミッション設定は tool 呼び出しごとに loadConfigs() で最新を取得する
// (config.json を外部から変更しても即座に反映される)

let scriptClient: ReturnType<typeof googleScript> | null = null;
let driveClient: ReturnType<typeof googleDrive> | null = null;

async function ensureAuth() {
  if (scriptClient && driveClient) return { script: scriptClient, drive: driveClient };
  const auth = await authorize(credentialsPath, tokensPath, scopes);
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

/** tool 呼び出しごとに最新権限を取得 */
async function resolveAccess(scriptId: string, required: "readonly" | "readwrite" | "execute") {
  const { permission, common } = await loadConfigs(configPath);
  const drive = common?.allowedFolders?.length ? await getDrive() : null;
  return await checkAccess(permission, common, drive, scriptId, required);
}

export function register(server: McpServer) {
// 1. list-projects
server.registerTool(
  "list-projects",
  {
    description: "allowlistに登録されたApps Scriptプロジェクト一覧を返す。レスポンスはTOON形式で返す。",
    inputSchema: {},
  },
  async () => {
    const { permission, common } = await loadConfigs(configPath);
    if (!permission && !common) {
      return textResult(
        "allowlistが設定されていません。GOOGLE_MCP_CONFIG 環境変数で設定ファイルを指定してください。"
      );
    }

    const projects = (permission?.allowedProjects ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      via: "direct",
    }));

    const folders = (common?.allowedFolders ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      access: entry.access ?? "readonly",
      via: "folder",
    }));

    const items = [...projects, ...folders];
    return items.length > 0
      ? toonResult({ allowedItems: items })
      : textResult("allowlistにApps Scriptプロジェクト/フォルダが登録されていません。");
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
    const { allowed, reason } = await resolveAccess(scriptId, "readonly");
    if (!allowed) return errorResult(reason!);

    const script = await getScript();
    const res = await script.projects.get({ scriptId });

    return toonResult({
      scriptId: res.data.scriptId ?? scriptId,
      title: res.data.title ?? "",
      createTime: res.data.createTime ?? "",
      updateTime: res.data.updateTime ?? "",
      parentId: res.data.parentId ?? "",
    });
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
    const { allowed, reason } = await resolveAccess(scriptId, "readonly");
    if (!allowed) return errorResult(reason!);

    const script = await getScript();
    const res = await script.projects.getContent({ scriptId });

    const files = (res.data.files ?? []).map((f) => ({
      name: f.name ?? "",
      type: f.type ?? "",
      source: f.source ?? "",
    }));

    return toonResult({
      scriptId: res.data.scriptId ?? scriptId,
      files,
    });
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
    const { allowed, reason } = await resolveAccess(scriptId, "readwrite");
    if (!allowed) return errorResult(reason!);

    const script = await getScript();
    await script.projects.updateContent({
      scriptId,
      requestBody: { files },
    });

    return textResult(`プロジェクトを更新しました（${files.length}ファイル）。`);
  }
);

// 5. run-function
server.registerTool(
  "run-function",
  {
    description:
      "Apps Scriptプロジェクトの関数を実行する（保存済みの最新コードを実行。デプロイは不要かつこのMCPからは行えない）。" +
      "allowedProjects に access: execute で個別登録されたプロジェクトのみ（folder 継承不可）。" +
      "制約: 対象スクリプトが OAuth クライアントと同じ GCP プロジェクトに紐づいている必要がある（スクリプトエディタの「プロジェクト設定」から変更）。" +
      "実行に失敗する場合はまずこの紐づけを確認すること。",
    inputSchema: {
      scriptId: z.string().describe("Apps ScriptプロジェクトID"),
      functionName: z.string().describe("実行する関数名"),
      parameters: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .default([])
        .describe("関数に渡す引数の配列（プリミティブ値のみ）"),
    },
  },
  async ({ scriptId, functionName, parameters }) => {
    const { allowed, reason } = await resolveAccess(scriptId, "execute");
    if (!allowed) return errorResult(reason!);

    const script = await getScript();
    const res = await script.scripts.run({
      scriptId,
      requestBody: {
        function: functionName,
        parameters,
        devMode: true,
      },
    });

    if (res.data.error) {
      const details = res.data.error.details?.[0] as
        | { errorMessage?: string; errorType?: string; scriptStackTraceElements?: unknown[] }
        | undefined;
      return errorResult(
        `スクリプト実行エラー: ${details?.errorType ?? ""} ${details?.errorMessage ?? JSON.stringify(res.data.error)}`
      );
    }

    const result = res.data.response?.result;
    return toonResult({
      functionName,
      result: result === undefined ? "(戻り値なし)" : result,
    });
  }
);

// 6. list-executions
server.registerTool(
  "list-executions",
  {
    description:
      "Apps Scriptプロジェクトの実行履歴（関数名・状態・実行時間・開始時刻）を取得する。トリガー実行や手動実行も含む。" +
      "詳細な Logger 出力はここでは取れないため、必要な場合は Apps Script ダッシュボードを案内すること。レスポンスはTOON形式で返す。",
    inputSchema: {
      scriptId: z.string().describe("Apps ScriptプロジェクトID"),
      maxResults: z.number().int().min(1).max(200).optional().default(50).describe("最大取得件数"),
      functionName: z.string().optional().describe("この関数名の実行だけに絞り込む"),
      statuses: z
        .array(
          z.enum(["COMPLETED", "FAILED", "TIMED_OUT", "RUNNING", "CANCELED", "PAUSED", "DELAYED", "UNKNOWN"])
        )
        .optional()
        .describe("この実行状態だけに絞り込む（例: [\"FAILED\"] で失敗のみ）"),
    },
  },
  async ({ scriptId, maxResults, functionName, statuses }) => {
    const { allowed, reason } = await resolveAccess(scriptId, "readonly");
    if (!allowed) return errorResult(reason!);

    const script = await getScript();
    const res = await script.processes.list({
      pageSize: maxResults,
      "userProcessFilter.scriptId": scriptId,
      ...(functionName ? { "userProcessFilter.functionName": functionName } : {}),
      ...(statuses?.length ? { "userProcessFilter.statuses": statuses } : {}),
    });

    const processes = (res.data.processes ?? []).map((p) => ({
      functionName: p.functionName ?? "",
      type: p.processType ?? "",
      status: p.processStatus ?? "",
      startTime: p.startTime ?? "",
      duration: p.duration ?? "",
    }));

    return processes.length > 0
      ? toonResult({ scriptId, processes })
      : textResult("実行履歴が見つかりませんでした。");
  }
);
}
