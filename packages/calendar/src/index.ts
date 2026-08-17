import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encode } from "@toon-format/toon";
import { authorize, resolveServiceEnv } from "@senchabrew/google-mcp-auth";
import { calendar as googleCalendar } from "@googleapis/calendar";
import { loadPermissionConfig, checkPermission, denyMessage, PermissionAction, OperationType } from "./permissions.js";
import { findMeetingUrl } from "./meeting-url.js";

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const { scopes, credentialsPath, tokensPath, configPath } = resolveServiceEnv(
  "google-calendar-mcp",
  [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ]
);

// パーミッション設定
const permConfig = await loadPermissionConfig(configPath);

// lazy auth: ツール呼び出し時に初めて認証する
let calClient: ReturnType<typeof googleCalendar> | null = null;
let selfEmail = "";

async function getCal() {
  if (!calClient) {
    const auth = await authorize(credentialsPath, tokensPath, scopes);
    calClient = googleCalendar({ version: "v3", auth });
    try {
      const me = await calClient.calendarList.get({ calendarId: "primary" });
      selfEmail = me.data.id ?? "";
    } catch {
      console.error("認証ユーザーのメールアドレスの取得に失敗しました");
    }
  }
  return calClient;
}

export function register(server: McpServer) {
server.registerTool(
  "get-current-time",
  {
    description: "現在の日時を取得する",
    inputSchema: {
      timeZone: z.string().optional().describe("IANAタイムゾーン（例: Asia/Tokyo）"),
    },
  },
  async ({ timeZone }) => {
    const tz = timeZone ?? "Asia/Tokyo";
    const now = new Date().toLocaleString("ja-JP", { timeZone: tz });
    return {
      content: [{ type: "text", text: `現在時刻 (${tz}): ${now}` }],
    };
  }
);

server.registerTool(
  "list-events",
  {
    description: "1人または複数人のカレンダーのイベント一覧を取得する。レスポンスはTOON形式で返す。",
    inputSchema: {
      calendarIds: z.array(z.string()).describe("カレンダーID（メールアドレス）の配列。自分のカレンダーは \"primary\""),
      timeMin: z.string().describe("開始日時（ISO 8601）"),
      timeMax: z.string().describe("終了日時（ISO 8601）"),
      maxResults: z.number().optional().default(50).describe("カレンダーごとの最大取得件数"),
    },
  },
  async ({ calendarIds, timeMin, timeMax, maxResults }) => {
    const cal = await getCal();
    const rows: {
      date: string; calendar: string; id: string; summary: string;
      start: string; end: string; location: string; description: string;
      conferenceUrl: string;
      attendees: { email: string; displayName: string; status: string; organizer: boolean; resource: boolean }[];
      isRecurring: boolean; status: string; transparency: string;
    }[] = [];

    for (const calendarId of calendarIds) {
      try {
        const res = await cal.events.list({
          calendarId,
          timeMin,
          timeMax,
          maxResults,
          singleEvents: true,
          orderBy: "startTime",
          ...({ conferenceDataVersion: 1 }),
        });

        for (const e of res.data.items ?? []) {
          const startDt = e.start?.dateTime ? new Date(e.start.dateTime) : null;
          const endDt = e.end?.dateTime ? new Date(e.end.dateTime) : null;
          const isAllDay = !e.start?.dateTime;

          const conferenceUri =
            e.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === "video")?.uri
            ?? findMeetingUrl(e.description)
            ?? findMeetingUrl(e.location)
            ?? "";

          rows.push({
            date: isAllDay
              ? (e.start?.date ?? "")
              : (startDt?.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }) ?? ""),
            calendar: calendarId,
            id: e.id ?? "",
            summary: e.summary ?? "(無題)",
            start: isAllDay ? "終日" : (startDt?.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }) ?? ""),
            end: isAllDay ? "" : (endDt?.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }) ?? ""),
            location: e.location ?? "",
            description: e.description ? stripHtml(e.description) : "",
            conferenceUrl: conferenceUri,
            attendees: (e.attendees ?? []).map((a) => ({
              email: a.email ?? "",
              displayName: a.displayName ?? "",
              status: a.responseStatus ?? "",
              organizer: a.organizer ?? false,
              resource: a.resource ?? false,
            })),
            isRecurring: !!e.recurringEventId,
            status: e.status ?? "",
            transparency: e.transparency ?? "opaque",
          });
        }
      } catch {
        rows.push({
          date: "",
          calendar: calendarId,
          id: "",
          summary: "(アクセス権限がありません)",
          start: "",
          end: "",
          location: "",
          description: "",
          conferenceUrl: "",
          attendees: [],
          isRecurring: false,
          status: "",
          transparency: "opaque",
        });
      }
    }

    return {
      content: [{
        type: "text",
        text: rows.length > 0
          ? encode({ events: rows })
          : "イベントが見つかりませんでした",
      }],
    };
  }
);

server.registerTool(
  "create-event",
  {
    description: "カレンダーイベントを作成する。",
    inputSchema: {
      calendarId: z.string().describe("カレンダーID。自分のカレンダーは \"primary\""),
      summary: z.string().describe("イベントのタイトル"),
      start: z.string().describe("開始日時（ISO 8601）"),
      end: z.string().describe("終了日時（ISO 8601）"),
      description: z.string().optional().describe("説明"),
      location: z.string().optional().describe("場所"),
      attendees: z.array(z.string()).optional().describe("ゲストのメールアドレスの配列"),
    },
  },
  async ({ calendarId, summary, start, end, description, location, attendees }) => {
    const cal = await getCal();
    const { action, condition } = checkPermission(permConfig, OperationType.Create, attendees ?? [], selfEmail);

    if (action === PermissionAction.Deny) {
      return {
        content: [{ type: "text", text: denyMessage(OperationType.Create, condition) }],
        isError: true,
      };
    }

    const event = await cal.events.insert({
      calendarId,
      requestBody: {
        summary,
        start: { dateTime: start, timeZone: "Asia/Tokyo" },
        end: { dateTime: end, timeZone: "Asia/Tokyo" },
        ...(description !== undefined && { description }),
        ...(location !== undefined && { location }),
        ...(attendees !== undefined && { attendees: attendees.map((email) => ({ email })) }),
      },
    });

    return {
      content: [{
        type: "text",
        text: `イベントを作成しました: ${event.data.summary ?? "(無題)"} (ID: ${event.data.id})`,
      }],
    };
  }
);

server.registerTool(
  "update-event",
  {
    description: "カレンダーイベントを更新する。変更したいフィールドのみ指定する。",
    inputSchema: {
      calendarId: z.string().describe("カレンダーID。自分のカレンダーは \"primary\""),
      eventId: z.string().describe("更新するイベントのID"),
      summary: z.string().optional().describe("新しいタイトル"),
      start: z.string().optional().describe("新しい開始日時（ISO 8601）"),
      end: z.string().optional().describe("新しい終了日時（ISO 8601）"),
      description: z.string().optional().describe("新しい説明"),
      location: z.string().optional().describe("新しい場所"),
      attendees: z.array(z.string()).optional().describe("新しいゲストのメールアドレスの配列（指定すると既存のゲストを置き換える）"),
    },
  },
  async ({ calendarId, eventId, summary, start, end, description, location, attendees: newAttendees }) => {
    const cal = await getCal();
    // 既存のイベントを取得してパーミッションチェック
    const existing = await cal.events.get({ calendarId, eventId });
    const existingAttendees = (existing.data.attendees ?? [])
      .map((a) => a.email)
      .filter((e): e is string => Boolean(e));

    const checkTarget = newAttendees !== undefined ? [...new Set([...existingAttendees, ...newAttendees])] : existingAttendees;
    const { action, condition } = checkPermission(permConfig, OperationType.Update, checkTarget, selfEmail);

    if (action === PermissionAction.Deny) {
      return {
        content: [{ type: "text", text: denyMessage(OperationType.Update, condition) }],
        isError: true,
      };
    }

    const patch: Record<string, unknown> = {};
    if (summary !== undefined) patch.summary = summary;
    if (description !== undefined) patch.description = description;
    if (location !== undefined) patch.location = location;
    if (start !== undefined) patch.start = { dateTime: start, timeZone: "Asia/Tokyo" };
    if (end !== undefined) patch.end = { dateTime: end, timeZone: "Asia/Tokyo" };
    if (newAttendees !== undefined) patch.attendees = newAttendees.map((email) => ({ email }));

    const updated = await cal.events.patch({
      calendarId,
      eventId,
      requestBody: patch,
    });

    return {
      content: [{
        type: "text",
        text: `イベントを更新しました: ${updated.data.summary ?? "(無題)"}`,
      }],
    };
  }
);

server.registerTool(
  "delete-event",
  {
    description: "カレンダーイベントを削除する。",
    inputSchema: {
      calendarId: z.string().describe("カレンダーID。自分のカレンダーは \"primary\""),
      eventId: z.string().describe("削除するイベントのID"),
    },
  },
  async ({ calendarId, eventId }) => {
    const cal = await getCal();
    // 既存のイベントを取得してパーミッションチェック
    const existing = await cal.events.get({ calendarId, eventId });
    const attendees = (existing.data.attendees ?? [])
      .map((a) => a.email)
      .filter((e): e is string => Boolean(e));

    const { action, condition } = checkPermission(permConfig, OperationType.Delete, attendees, selfEmail);

    if (action === PermissionAction.Deny) {
      return {
        content: [{ type: "text", text: denyMessage(OperationType.Delete, condition) }],
        isError: true,
      };
    }

    await cal.events.delete({ calendarId, eventId });

    return {
      content: [{
        type: "text",
        text: `イベント「${existing.data.summary ?? "(無題)"}」を削除しました。`,
      }],
    };
  }
);

server.registerTool(
  "freebusy",
  {
    description: "複数人のカレンダーの空き/忙し情報を取得する。予定の詳細は返さず、busy（予定あり）の時間帯のみ返す。日程調整に最適。レスポンスはTOON形式で返す。",
    inputSchema: {
      calendarIds: z.array(z.string()).describe("カレンダーID（メールアドレス）の配列。自分のカレンダーは \"primary\""),
      timeMin: z.string().describe("開始日時（ISO 8601）"),
      timeMax: z.string().describe("終了日時（ISO 8601）"),
    },
  },
  async ({ calendarIds, timeMin, timeMax }) => {
    const cal = await getCal();
    const res = await cal.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: "Asia/Tokyo",
        items: calendarIds.map((id) => ({ id })),
      },
    });

    const rows: { calendar: string; start: string; end: string; error: string }[] = [];

    for (const calendarId of calendarIds) {
      const data = res.data.calendars?.[calendarId];
      if (data?.errors?.length) {
        rows.push({
          calendar: calendarId,
          start: "",
          end: "",
          error: data.errors.map((e) => e.reason ?? "unknown").join(", "),
        });
      } else {
        for (const busy of data?.busy ?? []) {
          rows.push({
            calendar: calendarId,
            start: busy.start ?? "",
            end: busy.end ?? "",
            error: "",
          });
        }
      }
    }

    return {
      content: [{
        type: "text",
        text: rows.length > 0
          ? encode({ busy: rows })
          : "指定期間にbusy区間はありません",
      }],
    };
  }
);
}
