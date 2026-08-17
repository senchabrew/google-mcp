import {
  STANDARD_ACCESS_HIERARCHY,
  checkDirectAccess,
  findContainingAllowedFolder,
  getAllSubfolderIds,
  loadCommonConfig,
  loadConfig,
} from "@shivaduke28/google-mcp-auth";
import type {
  CommonConfig,
  FolderEntry,
  ResourceEntry,
  StandardAccess,
} from "@shivaduke28/google-mcp-auth";
import type { drive_v3 } from "@googleapis/drive";

export type PresentationEntry = ResourceEntry<StandardAccess>;

export interface PermissionConfig {
  allowedPresentations: PresentationEntry[];
}

export async function loadPermissionConfig(
  configPath: string | undefined
): Promise<PermissionConfig | null> {
  return await loadConfig<PermissionConfig>(configPath, "slides");
}

export async function loadConfigs(configPath: string | undefined): Promise<{
  permission: PermissionConfig | null;
  common: CommonConfig | null;
}> {
  const [permission, common] = await Promise.all([
    loadPermissionConfig(configPath),
    loadCommonConfig(configPath),
  ]);
  return { permission, common };
}

/**
 * Presentation にアクセスできるか判定する
 * 1. permission.allowedPresentations に直接 hit → entry の access チェック
 * 2. drive で親 folder を辿り、common.allowedFolders の子孫なら folder の access を継承
 * 3. どちらでもなければ deny
 */
export async function checkAccess(
  permission: PermissionConfig | null,
  common: CommonConfig | null,
  drive: drive_v3.Drive | null,
  fileId: string,
  requireWrite: boolean
): Promise<{ allowed: boolean; reason?: string }> {
  const required: StandardAccess = requireWrite ? "readwrite" : "readonly";

  // allowlist 未設定 = 全許可 (read のみ。write は厳密)
  if (!permission && !common) {
    if (requireWrite) {
      return {
        allowed: false,
        reason: `書き込み操作には allowlist 経由の access: readwrite 登録が必須です。GOOGLE_MCP_CONFIG を設定してください。`,
      };
    }
    return { allowed: true };
  }

  // 1. 直接 allowlist hit
  if (permission?.allowedPresentations?.length) {
    const direct = checkDirectAccess(
      permission.allowedPresentations,
      fileId,
      required,
      STANDARD_ACCESS_HIERARCHY
    );
    if (direct.entry) {
      return direct;
    }
  }

  // 2. 共通 allowedFolders 経由 (drive 必須)
  if (common?.allowedFolders?.length && drive) {
    try {
      const fileMeta = await drive.files.get({
        fileId,
        fields: "parents",
        supportsAllDrives: true,
      });
      const parentIds = fileMeta.data.parents ?? [];
      const folder = await findContainingAllowedFolder(
        drive,
        common.allowedFolders,
        parentIds
      );
      if (folder) {
        const folderAccess: StandardAccess = folder.access ?? "readonly";
        if (folderAccess === "readwrite" || !requireWrite) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: `Presentation (${fileId}) は allowedFolders「${folder.name}」経由で access: ${folderAccess} です。${required} 操作には folder の access を readwrite に上げてください。`,
        };
      }
    } catch {
      // file 取得失敗時はそのまま deny
    }
  }

  return {
    allowed: false,
    reason: `Presentation (${fileId}) は allowlist に登録されていません。allowedPresentations または allowedFolders の配下に追加してください。`,
  };
}

/**
 * folder ID が common.allowedFolders に直接 or 子孫として含まれるか判定する
 */
export async function checkFolderAccess(
  common: CommonConfig | null,
  drive: drive_v3.Drive | null,
  folderId: string
): Promise<{ allowed: boolean; folder?: FolderEntry<StandardAccess>; reason?: string }> {
  if (!common) return { allowed: true };

  const direct = common.allowedFolders?.find((e) => e.id === folderId);
  if (direct) return { allowed: true, folder: direct };

  if (common.allowedFolders?.length && drive) {
    const folder = await findContainingAllowedFolder(drive, common.allowedFolders, [folderId]);
    if (folder) return { allowed: true, folder };
  }

  return {
    allowed: false,
    reason: `フォルダ (${folderId}) は allowlist (allowedFolders) に登録されていません。`,
  };
}

export { getAllSubfolderIds };
export type { CommonConfig, FolderEntry };
