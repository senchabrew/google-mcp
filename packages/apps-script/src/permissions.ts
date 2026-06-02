import {
  STANDARD_ACCESS_HIERARCHY,
  checkDirectAccess,
  findContainingAllowedFolder,
  hasAccess,
  loadCommonConfig,
  loadConfig,
} from "@shivaduke28/google-mcp-auth";
import type {
  CommonConfig,
  ResourceEntry,
} from "@shivaduke28/google-mcp-auth";
import type { drive_v3 } from "@googleapis/drive";

/** apps-script 固有の access level */
export type AppsScriptAccess = "readonly" | "readwrite" | "execute";

/** apps-script の階層: readonly < readwrite < execute (execute は readwrite/readonly を含む) */
export const APPS_SCRIPT_ACCESS_HIERARCHY: Record<string, number> = {
  readonly: 1,
  readwrite: 2,
  execute: 3,
};

export type ProjectEntry = ResourceEntry<AppsScriptAccess>;

export interface PermissionConfig {
  allowedProjects: ProjectEntry[];
}

export async function loadPermissionConfig(
  configPath: string | undefined
): Promise<PermissionConfig | null> {
  return await loadConfig<PermissionConfig>(configPath, "apps-script");
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
 * Apps Script project にアクセスできるか判定する
 * 1. permission.allowedProjects に直接 hit → entry.access チェック
 * 2. requireExecute なら folder 継承スキップ (execute は明示登録必須)
 * 3. drive で親 folder を辿り、common.allowedFolders 子孫なら folder.access (standard) を継承
 * 4. どちらでもなければ deny
 */
export async function checkAccess(
  permission: PermissionConfig | null,
  common: CommonConfig | null,
  drive: drive_v3.Drive | null,
  scriptId: string,
  required: AppsScriptAccess
): Promise<{ allowed: boolean; reason?: string }> {
  // allowlist 未設定 = 全許可 (read のみ。write/execute は厳密)
  if (!permission && !common) {
    if (required !== "readonly") {
      return {
        allowed: false,
        reason: `${required} 操作には allowlist 経由の access 登録が必須です。GOOGLE_MCP_CONFIG を設定してください。`,
      };
    }
    return { allowed: true };
  }

  // 1. 直接 allowlist hit
  if (permission?.allowedProjects?.length) {
    const direct = checkDirectAccess(
      permission.allowedProjects,
      scriptId,
      required,
      APPS_SCRIPT_ACCESS_HIERARCHY
    );
    if (direct.entry) {
      return direct;
    }
  }

  // 2. execute は folder 経由不可
  if (required === "execute") {
    return {
      allowed: false,
      reason: `Apps Script project (${scriptId}) の execute 権限は allowedProjects に access: execute で個別登録が必要です (folder 継承は不可)。`,
    };
  }

  // 3. 共通 allowedFolders 経由 (drive 必須、standard access のみ)
  if (common?.allowedFolders?.length && drive) {
    try {
      const fileMeta = await drive.files.get({
        fileId: scriptId,
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
        const folderAccess = folder.access ?? "readonly";
        // folder access は standard (readonly | readwrite) のみ。
        // required も readonly か readwrite なので standard hierarchy で OK
        if (hasAccess(folderAccess, required, STANDARD_ACCESS_HIERARCHY)) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: `Apps Script project (${scriptId}) は allowedFolders「${folder.name}」経由で access: ${folderAccess} です。${required} 操作には folder の access を引き上げてください。`,
        };
      }
    } catch {
      // file 取得失敗時はそのまま deny
    }
  }

  return {
    allowed: false,
    reason: `Apps Script project (${scriptId}) は allowlist に登録されていません。allowedProjects または allowedFolders の配下に追加してください。`,
  };
}
