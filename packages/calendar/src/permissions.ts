import { loadConfig } from "@senchabrew/google-mcp-auth";

export const PermissionAction = {
  Allow: "allow",
  Deny: "deny",
} as const;

export type PermissionAction = (typeof PermissionAction)[keyof typeof PermissionAction];

export const OperationType = {
  Read: "read",
  Create: "create",
  Update: "update",
  Delete: "delete",
} as const;

export type OperationType = (typeof OperationType)[keyof typeof OperationType];

export interface ConditionalPermission {
  self_only: PermissionAction;
  internal: PermissionAction;
  external: PermissionAction;
}

export interface PermissionConfig {
  internalDomain: string;
  permissions: {
    read: ConditionalPermission;
    create: ConditionalPermission;
    update: ConditionalPermission;
    delete: ConditionalPermission;
  };
}

const DEFAULT_CONFIG: PermissionConfig = {
  internalDomain: "",
  permissions: {
    read: {
      self_only: PermissionAction.Allow,
      internal: PermissionAction.Allow,
      external: PermissionAction.Allow,
    },
    create: {
      self_only: PermissionAction.Allow,
      internal: PermissionAction.Deny,
      external: PermissionAction.Deny,
    },
    update: {
      self_only: PermissionAction.Allow,
      internal: PermissionAction.Deny,
      external: PermissionAction.Deny,
    },
    delete: {
      self_only: PermissionAction.Deny,
      internal: PermissionAction.Deny,
      external: PermissionAction.Deny,
    },
  },
};

export async function loadPermissionConfig(
  configPath: string | undefined
): Promise<PermissionConfig> {
  const parsed = await loadConfig<Partial<PermissionConfig>>(configPath, "calendar");
  if (!parsed) return DEFAULT_CONFIG;

  return {
    internalDomain: parsed.internalDomain ?? DEFAULT_CONFIG.internalDomain,
    permissions: {
      read: parsed.permissions?.read ?? DEFAULT_CONFIG.permissions.read,
      create: parsed.permissions?.create ?? DEFAULT_CONFIG.permissions.create,
      update: parsed.permissions?.update ?? DEFAULT_CONFIG.permissions.update,
      delete: parsed.permissions?.delete ?? DEFAULT_CONFIG.permissions.delete,
    },
  };
}

export const AttendeeCondition = {
  SelfOnly: "self_only",
  Internal: "internal",
  External: "external",
} as const;

type AttendeeCondition = (typeof AttendeeCondition)[keyof typeof AttendeeCondition];

export function classifyAttendees(
  attendees: string[],
  selfEmail: string,
  internalDomain: string
): AttendeeCondition {
  const others = attendees.filter(
    (email) => email.toLowerCase() !== selfEmail.toLowerCase()
  );

  if (others.length === 0) return AttendeeCondition.SelfOnly;

  if (internalDomain && others.every((email) => email.toLowerCase().endsWith(`@${internalDomain.toLowerCase()}`))) {
    return AttendeeCondition.Internal;
  }

  return AttendeeCondition.External;
}

export interface PermissionCheckResult {
  action: PermissionAction;
  condition: AttendeeCondition;
}

export function checkPermission(
  config: PermissionConfig,
  operation: OperationType,
  attendees: string[],
  selfEmail: string
): PermissionCheckResult {
  const perm = config.permissions[operation];
  const condition = classifyAttendees(attendees, selfEmail, config.internalDomain);

  return { action: perm[condition], condition };
}

const CONDITION_LABELS: Record<AttendeeCondition, string> = {
  [AttendeeCondition.SelfOnly]: "自分のみ",
  [AttendeeCondition.Internal]: "内部メンバー",
  [AttendeeCondition.External]: "外部参加者",
};

export function denyMessage(operation: OperationType, condition: AttendeeCondition): string {
  return `${CONDITION_LABELS[condition]}を含むイベントの${operation}は許可されていません。`;
}
