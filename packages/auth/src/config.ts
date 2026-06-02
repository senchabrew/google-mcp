import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export async function loadConfig<T>(
  configPath: string | undefined,
  key?: string
): Promise<T | null> {
  if (!configPath) return null;

  if (!existsSync(configPath)) {
    console.error(`config ファイルが見つかりません: ${configPath}`);
    return null;
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (key === undefined) return parsed as T;
    const section = parsed[key];
    if (section === undefined) return null;
    return section as T;
  } catch {
    console.error(`config ファイルの読み込みに失敗しました: ${configPath}`);
    return null;
  }
}
