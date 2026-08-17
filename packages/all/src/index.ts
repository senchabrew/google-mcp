// 全 Google サービスを 1 つの MCP サーバーに統合したエントリ。
// 各サービスは register(server) を export する composable モジュールに改修済み。
// ツール名はサービス名で prefix して衝突 (docs/slides の list-folder 等) を回避する。
//
// 認証は union scope + 共有 tokens ファイルにより 1 回の OAuth で全機能をカバーする
// (env GOOGLE_OAUTH_SCOPES / GOOGLE_OAUTH_TOKENS は呼び出し元 index.js が設定)。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { register as registerSheets } from "../../sheets/src/index.js";
import { register as registerDocs } from "../../docs/src/index.js";
import { register as registerSlides } from "../../slides/src/index.js";
import { register as registerAppsScript } from "../../apps-script/src/index.js";
import { register as registerCalendar } from "../../calendar/src/index.js";
import { register as registerGmail } from "../../gmail/src/index.js";

// registerTool の name に prefix を付けて衝突を防ぐ薄い Proxy。
// その他のメソッド (registerResource 等) はそのまま透過する。
function withPrefix(server: McpServer, prefix: string): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name: string, ...rest: unknown[]) =>
          (target.registerTool as (...a: unknown[]) => unknown)(
            prefix + name,
            ...rest
          );
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as McpServer;
}

const server = new McpServer({ name: "google-mcp-all", version: "1.0.0" });

registerSheets(withPrefix(server, "sheets_"));
registerDocs(withPrefix(server, "docs_"));
registerSlides(withPrefix(server, "slides_"));
registerAppsScript(withPrefix(server, "appsscript_"));
registerCalendar(withPrefix(server, "calendar_"));
registerGmail(withPrefix(server, "gmail_"));

const transport = new StdioServerTransport();
await server.connect(transport);
