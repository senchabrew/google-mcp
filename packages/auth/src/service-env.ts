import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePath } from "./resolve-path.js";

export interface ServiceEnv {
  scopes: string[];
  credentialsPath: string;
  tokensPath: string;
  configPath?: string;
}

/**
 * 各 MCP サーバー共通の環境変数解決。
 * GOOGLE_OAUTH_SCOPES / GOOGLE_OAUTH_CREDENTIALS / GOOGLE_OAUTH_TOKENS / GOOGLE_MCP_CONFIG
 * を読み、未設定の項目は defaultScopes / `~/.config/{tokensDirName}/tokens.json` に落とす。
 * credentials が見つからない場合はプロセスを終了する。
 */
export function resolveServiceEnv(
  tokensDirName: string,
  defaultScopes: string[]
): ServiceEnv {
  const scopes = process.env.GOOGLE_OAUTH_SCOPES
    ? process.env.GOOGLE_OAUTH_SCOPES.split(" ").filter(Boolean)
    : defaultScopes;

  const rawCredentialsPath = process.env.GOOGLE_OAUTH_CREDENTIALS;
  if (!rawCredentialsPath) {
    console.error("GOOGLE_OAUTH_CREDENTIALS 環境変数を設定してください");
    process.exit(1);
  }
  const credentialsPath = resolvePath(rawCredentialsPath);
  if (!existsSync(credentialsPath)) {
    console.error(`credentials.json が見つかりません: ${credentialsPath}`);
    process.exit(1);
  }

  const tokensPath = process.env.GOOGLE_OAUTH_TOKENS
    ? resolvePath(process.env.GOOGLE_OAUTH_TOKENS)
    : join(homedir(), ".config", tokensDirName, "tokens.json");

  const configPath = process.env.GOOGLE_MCP_CONFIG
    ? resolvePath(process.env.GOOGLE_MCP_CONFIG)
    : undefined;

  return { scopes, credentialsPath, tokensPath, configPath };
}
