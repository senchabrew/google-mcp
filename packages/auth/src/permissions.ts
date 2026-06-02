import { loadConfig } from "./config.js";
import type { drive_v3 } from "@googleapis/drive";

const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/**
 * 標準 access level (sheets / docs 用)。apps-script は独自拡張。
 * `deny` は明示的にアクセス不可を示す (例: folder readwrite で広く許可しつつ、
 * 個別 entry を deny にすることで「このファイルだけは触らない」を表現する用途)
 */
export type StandardAccess = "deny" | "readonly" | "readwrite";

/** リソース (file) の許可エントリ */
export interface ResourceEntry<A extends string = StandardAccess> {
  id: string;
  name: string;
  access?: A;
}

/** フォルダの許可エントリ。配下ファイルに access を継承する */
export interface FolderEntry<A extends string = StandardAccess> {
  id: string;
  name: string;
  access?: A;
}

/** config.json ルートに置かれる、全 MCP server 共通の許可フォルダ */
export interface CommonConfig {
  allowedFolders?: FolderEntry<StandardAccess>[];
}

/** ルートから共通設定 (allowedFolders) を読む */
export async function loadCommonConfig(
  configPath?: string
): Promise<CommonConfig | null> {
  return await loadConfig<CommonConfig>(configPath);
}

/** 標準 access の階層: deny < readonly < readwrite */
export const STANDARD_ACCESS_HIERARCHY: Record<string, number> = {
  deny: 0,
  readonly: 1,
  readwrite: 2,
};

/**
 * given access が required access を満たすか判定する
 * (階層が高いほど強い権限)
 */
export function hasAccess(
  given: string | undefined,
  required: string,
  hierarchy: Record<string, number>
): boolean {
  // given が undefined のときは default readonly (= 1) として扱う。
  // 明示的に deny (= 0) を立てたい場合は entry.access に "deny" を書く。
  const givenLevel =
    given !== undefined ? hierarchy[given] ?? 0 : hierarchy["readonly"] ?? 0;
  const requiredLevel = hierarchy[required] ?? 0;
  // requiredLevel = 0 (deny) の要求は意味的に成立しないので false 扱い
  if (requiredLevel === 0) return false;
  return givenLevel >= requiredLevel;
}

/**
 * allowlist の entries に直接 hit するか判定し、hit すれば access チェックする。
 * folder 経由のアクセスはこの関数の対象外 (`findContainingAllowedFolder` を別途使う)。
 */
export function checkDirectAccess<A extends string>(
  entries: ResourceEntry<A>[],
  fileId: string,
  requiredAccess: A,
  hierarchy: Record<string, number>
): { allowed: boolean; entry?: ResourceEntry<A>; reason?: string } {
  const entry = entries.find((e) => e.id === fileId);
  if (!entry) {
    return {
      allowed: false,
      reason: `リソース (${fileId}) は allowlist に登録されていません。`,
    };
  }
  if (!hasAccess(entry.access, requiredAccess, hierarchy)) {
    return {
      allowed: false,
      entry,
      reason: `リソース (${fileId}) は access: ${entry.access ?? "readonly"} で登録されています。${requiredAccess} 操作には access の引き上げが必要です。`,
    };
  }
  return { allowed: true, entry };
}

/**
 * ファイルの parents から再帰的に祖先を辿り、allowedFolders に到達したら
 * そのフォルダエントリを返す。到達しなければ null。
 * (folder access の継承判定に使う)
 */
export async function findContainingAllowedFolder<A extends string>(
  drive: drive_v3.Drive,
  allowedFolders: FolderEntry<A>[] | undefined,
  parentIds: string[]
): Promise<FolderEntry<A> | null> {
  if (!allowedFolders || allowedFolders.length === 0) return null;

  const folderMap = new Map(allowedFolders.map((f) => [f.id, f]));
  const visited = new Set<string>();

  async function check(ids: string[]): Promise<FolderEntry<A> | null> {
    for (const id of ids) {
      if (visited.has(id)) continue;
      visited.add(id);

      const hit = folderMap.get(id);
      if (hit) return hit;

      try {
        const res = await drive.files.get({
          fileId: id,
          fields: "parents",
          supportsAllDrives: true,
        });
        const grandParents = res.data.parents ?? [];
        if (grandParents.length > 0) {
          const result = await check(grandParents);
          if (result) return result;
        }
      } catch {
        // ファイルが見つからない場合はスキップ
      }
    }
    return null;
  }

  return check(parentIds);
}

/**
 * 指定フォルダ配下の全サブフォルダ ID を再帰取得する
 * (`list-folder` などで再帰探索したいとき用)
 */
export async function getAllSubfolderIds(
  drive: drive_v3.Drive,
  folderId: string
): Promise<string[]> {
  const result: string[] = [];
  const visited = new Set<string>();

  async function collect(parentId: string): Promise<void> {
    if (visited.has(parentId)) return;
    visited.add(parentId);

    const res = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = '${GOOGLE_FOLDER_MIME_TYPE}' and trashed = false`,
      fields: "files(id)",
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of res.data.files ?? []) {
      if (file.id) {
        result.push(file.id);
        await collect(file.id);
      }
    }
  }

  await collect(folderId);
  return result;
}
