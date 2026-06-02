import {
  STANDARD_ACCESS_HIERARCHY,
  checkDirectAccess,
  findContainingAllowedFolder,
  loadCommonConfig,
  loadConfig,
} from "@shivaduke28/google-mcp-auth";
import type {
  CommonConfig,
  ResourceEntry,
  StandardAccess,
} from "@shivaduke28/google-mcp-auth";
import type { drive_v3 } from "@googleapis/drive";

export type SpreadsheetEntry = ResourceEntry<StandardAccess>;

export interface PermissionConfig {
  allowedSpreadsheets: SpreadsheetEntry[];
}

export async function loadPermissionConfig(
  configPath: string | undefined
): Promise<PermissionConfig | null> {
  return await loadConfig<PermissionConfig>(configPath, "sheets");
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
 * Spreadsheet にアクセスできるか判定する
 * 1. permission.allowedSpreadsheets に直接 hit → entry の access チェック
 * 2. drive で親 folder を辿り、common.allowedFolders の子孫なら folder の access を継承
 * 3. どちらでもなければ deny
 *
 * drive が null の場合は folder 経由のチェックをスキップする (initial setup や test 用)
 */
export async function checkAccess(
  permission: PermissionConfig | null,
  common: CommonConfig | null,
  drive: drive_v3.Drive | null,
  spreadsheetId: string,
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
  if (permission?.allowedSpreadsheets?.length) {
    const direct = checkDirectAccess(
      permission.allowedSpreadsheets,
      spreadsheetId,
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
        fileId: spreadsheetId,
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
          reason: `Spreadsheet (${spreadsheetId}) は allowedFolders「${folder.name}」経由で access: ${folderAccess} です。${required} 操作には folder の access を readwrite に上げてください。`,
        };
      }
    } catch {
      // file 取得失敗時はそのまま deny
    }
  }

  return {
    allowed: false,
    reason: `Spreadsheet (${spreadsheetId}) は allowlist に登録されていません。allowedSpreadsheets または allowedFolders の配下に追加してください。`,
  };
}
