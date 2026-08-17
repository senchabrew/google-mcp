import type { gmail_v1 } from "@googleapis/gmail";

export interface MessageHeaders {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
}

export function extractHeaders(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined
): MessageHeaders {
  const get = (name: string): string => {
    return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
  };

  return {
    from: get("From"),
    to: get("To"),
    cc: get("Cc"),
    subject: get("Subject"),
    date: get("Date"),
  };
}

export function extractBody(
  payload: gmail_v1.Schema$MessagePart | undefined
): string {
  if (!payload) return "";

  // text/plain を直接持っている場合
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // multipart の場合は再帰的にパース
  if (payload.parts) {
    // まず text/plain を探す
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // text/plain がなければ再帰的に探す
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }

  return "";
}

export interface AttachmentPart {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

/** メッセージ payload から添付ファイルパートを再帰的に収集する */
export function extractAttachmentParts(
  payload: gmail_v1.Schema$MessagePart | undefined
): AttachmentPart[] {
  if (!payload) return [];
  const result: AttachmentPart[] = [];

  if (payload.filename && payload.body?.attachmentId) {
    result.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      attachmentId: payload.body.attachmentId,
      size: payload.body.size ?? 0,
    });
  }

  for (const part of payload.parts ?? []) {
    result.push(...extractAttachmentParts(part));
  }

  return result;
}

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function encodeBase64Url(data: string): string {
  return Buffer.from(data, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 非ASCII文字を含むヘッダー値を RFC 2047 encoded-word にする */
function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

export interface DraftAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export interface RawMessageOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: DraftAttachment[];
}

export function buildRawMessage(opts: RawMessageOptions): string {
  const { to, cc = [], bcc = [], subject, body, inReplyTo, references, attachments = [] } = opts;

  const headerLines: string[] = [];
  headerLines.push(`To: ${to.join(", ")}`);
  if (cc.length > 0) {
    headerLines.push(`Cc: ${cc.join(", ")}`);
  }
  if (bcc.length > 0) {
    headerLines.push(`Bcc: ${bcc.join(", ")}`);
  }
  headerLines.push(`Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`);
  headerLines.push("MIME-Version: 1.0");
  if (inReplyTo) {
    headerLines.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (references) {
    headerLines.push(`References: ${references}`);
  }

  const lines: string[] = [...headerLines];

  if (attachments.length === 0) {
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(Buffer.from(body).toString("base64"));
    return encodeBase64Url(lines.join("\r\n"));
  }

  // 添付あり: multipart/mixed
  const boundary = `----=_mcp_${Date.now().toString(36)}_boundary`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push("");

  // 本文パート
  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(Buffer.from(body).toString("base64"));

  // 添付パート
  for (const att of attachments) {
    const filename = encodeHeaderValue(att.filename);
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.mimeType}; name="${filename}"`);
    lines.push(`Content-Disposition: attachment; filename="${filename}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(att.contentBase64);
  }
  lines.push(`--${boundary}--`);

  return encodeBase64Url(lines.join("\r\n"));
}
