import { readFile, writeFile } from "node:fs/promises";
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

/**
 * config.json の {serviceKey: {listKey: [...]}} に allowlist エントリを追記して永続化する。
 * 新規作成したリソースを allowlist に自動登録する用途。成功したら true。
 * (次の tool 呼び出しで loadConfig が再 read するため、メモリ反映の追加処理は不要)
 */
export async function appendAllowlistEntry(
  configPath: string | undefined,
  serviceKey: string,
  listKey: string,
  entry: { id: string; name: string; access?: string }
): Promise<boolean> {
  if (!configPath) return false;
  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content) as Record<string, unknown>;
    const section = (config[serviceKey] ?? {}) as Record<string, unknown>;
    const list = (section[listKey] ?? []) as Array<{ id: string }>;
    list.push(entry);
    section[listKey] = list;
    config[serviceKey] = section;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } catch (e) {
    console.error(`config.json 書き戻し失敗: ${e}`);
    return false;
  }
}
