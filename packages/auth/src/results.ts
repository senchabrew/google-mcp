import { encode } from "@toon-format/toon";

/** MCP tool の戻り値 (CallToolResult 互換の最小形) */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** プレーンテキストを返す */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/** オブジェクトを TOON 形式で返す */
export function toonResult(obj: unknown): ToolResult {
  return textResult(encode(obj));
}

/** isError 付きでテキストを返す */
export function errorResult(text: string): ToolResult {
  return { ...textResult(text), isError: true };
}
