import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractHeaders,
  extractBody,
  extractAttachmentParts,
  buildRawMessage,
} from "../src/gmail.js";

describe("extractHeaders", () => {
  it("ヘッダーからFrom/To/Cc/Subject/Dateを抽出する", () => {
    const headers = [
      { name: "From", value: "alice@example.com" },
      { name: "To", value: "bob@example.com" },
      { name: "Cc", value: "carol@example.com" },
      { name: "Subject", value: "Hello" },
      { name: "Date", value: "Mon, 10 Feb 2026 12:00:00 +0900" },
    ];
    const result = extractHeaders(headers);
    assert.equal(result.from, "alice@example.com");
    assert.equal(result.to, "bob@example.com");
    assert.equal(result.cc, "carol@example.com");
    assert.equal(result.subject, "Hello");
    assert.equal(result.date, "Mon, 10 Feb 2026 12:00:00 +0900");
  });

  it("ヘッダーが大文字小文字混在でもマッチする", () => {
    const headers = [
      { name: "from", value: "alice@example.com" },
      { name: "SUBJECT", value: "Test" },
    ];
    const result = extractHeaders(headers);
    assert.equal(result.from, "alice@example.com");
    assert.equal(result.subject, "Test");
  });

  it("存在しないヘッダーは空文字を返す", () => {
    const result = extractHeaders([]);
    assert.equal(result.from, "");
    assert.equal(result.to, "");
    assert.equal(result.cc, "");
    assert.equal(result.subject, "");
    assert.equal(result.date, "");
  });

  it("undefinedの場合も空文字を返す", () => {
    const result = extractHeaders(undefined);
    assert.equal(result.from, "");
  });
});

describe("extractBody", () => {
  it("text/plainのbodyをデコードする", () => {
    const base64url = Buffer.from("Hello, World!").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = {
      mimeType: "text/plain",
      body: { data: base64url },
    };
    assert.equal(extractBody(payload), "Hello, World!");
  });

  it("multipartからtext/plainを抽出する", () => {
    const textData = Buffer.from("Plain text body").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const htmlData = Buffer.from("<p>HTML body</p>").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: textData } },
        { mimeType: "text/html", body: { data: htmlData } },
      ],
    };
    assert.equal(extractBody(payload), "Plain text body");
  });

  it("ネストしたmultipartからtext/plainを再帰的に抽出する", () => {
    const textData = Buffer.from("Nested plain").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: textData } },
          ],
        },
      ],
    };
    assert.equal(extractBody(payload), "Nested plain");
  });

  it("payloadがundefinedなら空文字を返す", () => {
    assert.equal(extractBody(undefined), "");
  });

  it("bodyがないパートはスキップされる", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: {} },
        { mimeType: "text/plain", body: { data: Buffer.from("Found").toString("base64") } },
      ],
    };
    assert.equal(extractBody(payload), "Found");
  });

  it("日本語のbodyをデコードする", () => {
    const text = "こんにちは世界";
    const base64url = Buffer.from(text).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = {
      mimeType: "text/plain",
      body: { data: base64url },
    };
    assert.equal(extractBody(payload), text);
  });
});

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

describe("buildRawMessage", () => {
  it("基本的なメッセージをbase64urlエンコードする", () => {
    const raw = buildRawMessage({
      to: ["bob@example.com"],
      subject: "Test Subject",
      body: "Hello Bob",
    });
    // base64urlなので+や/や=は含まれない
    assert.ok(!raw.includes("+"));
    assert.ok(!raw.includes("/"));
    assert.ok(!raw.includes("="));

    // デコードして中身を確認
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("To: bob@example.com"));
    assert.ok(decoded.includes("MIME-Version: 1.0"));
    assert.ok(decoded.includes("Content-Type: text/plain; charset=UTF-8"));
  });

  it("CCが含まれる場合Ccヘッダーが付く", () => {
    const raw = buildRawMessage({
      to: ["bob@example.com"],
      cc: ["carol@example.com", "dave@example.com"],
      subject: "With CC",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("Cc: carol@example.com, dave@example.com"));
  });

  it("CCが空の場合Ccヘッダーが付かない", () => {
    const raw = buildRawMessage({
      to: ["bob@example.com"],
      subject: "No CC",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(!decoded.includes("Cc:"));
  });

  it("BCCが含まれる場合Bccヘッダーが付く", () => {
    const raw = buildRawMessage({
      to: ["bob@example.com"],
      bcc: ["secret@example.com"],
      subject: "With BCC",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("Bcc: secret@example.com"));
  });

  it("日本語の件名がBase64エンコードされる", () => {
    const raw = buildRawMessage({
      to: ["bob@example.com"],
      subject: "テスト件名",
      body: "本文",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("Subject: =?UTF-8?B?"));
    // Subject内のbase64をデコードして確認
    const match = decoded.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/);
    assert.ok(match);
    const subject = Buffer.from(match![1], "base64").toString("utf-8");
    assert.equal(subject, "テスト件名");
  });

  it("返信時にIn-Reply-ToとReferencesヘッダーが付く", () => {
    const raw = buildRawMessage({
      to: ["bob@example.com"],
      subject: "Re: Test",
      body: "Reply body",
      inReplyTo: "<msg-id-123@mail.gmail.com>",
      references: "<msg-id-000@mail.gmail.com> <msg-id-123@mail.gmail.com>",
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("In-Reply-To: <msg-id-123@mail.gmail.com>"));
    assert.ok(decoded.includes("References: <msg-id-000@mail.gmail.com> <msg-id-123@mail.gmail.com>"));
  });

  it("添付ありの場合multipart/mixedになり本文と添付パートを含む", () => {
    const pdfContent = Buffer.from("%PDF-1.4 dummy").toString("base64");
    const raw = buildRawMessage({
      to: ["bob@example.com"],
      subject: "With attachment",
      body: "See attached",
      attachments: [
        { filename: "quote.pdf", mimeType: "application/pdf", contentBase64: pdfContent },
      ],
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes("Content-Type: multipart/mixed; boundary="));
    assert.ok(decoded.includes("Content-Type: text/plain; charset=UTF-8"));
    assert.ok(decoded.includes('Content-Type: application/pdf; name="quote.pdf"'));
    assert.ok(decoded.includes('Content-Disposition: attachment; filename="quote.pdf"'));
    assert.ok(decoded.includes(pdfContent));
    // 終端boundary
    assert.ok(/--\r\n?$|--$/.test(decoded.trim()));
  });

  it("日本語ファイル名の添付はencoded-wordになる", () => {
    const raw = buildRawMessage({
      to: ["bob@example.com"],
      subject: "With JP attachment",
      body: "See attached",
      attachments: [
        { filename: "見積書.pdf", mimeType: "application/pdf", contentBase64: "QUJD" },
      ],
    });
    const decoded = decodeRaw(raw);
    assert.ok(decoded.includes('filename="=?UTF-8?B?'));
  });

  it("添付なしの場合はmultipartにならない(従来形式)", () => {
    const raw = buildRawMessage({
      to: ["bob@example.com"],
      subject: "Plain",
      body: "Hello",
    });
    const decoded = decodeRaw(raw);
    assert.ok(!decoded.includes("multipart/mixed"));
  });
});

describe("extractAttachmentParts", () => {
  it("添付パートを収集する", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", filename: "", body: { data: "aGk" } },
        {
          mimeType: "application/pdf",
          filename: "report.pdf",
          body: { attachmentId: "att-1", size: 1234 },
        },
      ],
    };
    const result = extractAttachmentParts(payload);
    assert.equal(result.length, 1);
    assert.equal(result[0].filename, "report.pdf");
    assert.equal(result[0].attachmentId, "att-1");
    assert.equal(result[0].size, 1234);
  });

  it("ネストしたパートからも収集する", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "image/png",
              filename: "image.png",
              body: { attachmentId: "att-2", size: 10 },
            },
          ],
        },
      ],
    };
    const result = extractAttachmentParts(payload);
    assert.equal(result.length, 1);
    assert.equal(result[0].filename, "image.png");
  });

  it("attachmentIdのないfilename付きパートは含めない", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "text/plain", filename: "inline.txt", body: { data: "aGk" } }],
    };
    assert.equal(extractAttachmentParts(payload).length, 0);
  });

  it("payloadがundefinedなら空配列", () => {
    assert.equal(extractAttachmentParts(undefined).length, 0);
  });
});
