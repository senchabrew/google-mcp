import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  STANDARD_ACCESS_HIERARCHY,
  checkDirectAccess,
  hasAccess,
} from "../src/permissions.js";
import type { ResourceEntry, StandardAccess } from "../src/permissions.js";

const APPS_SCRIPT_HIERARCHY = {
  readonly: 1,
  readwrite: 2,
  execute: 3,
};

describe("hasAccess", () => {
  it("given >= required で true", () => {
    assert.equal(hasAccess("readwrite", "readonly", STANDARD_ACCESS_HIERARCHY), true);
    assert.equal(hasAccess("readwrite", "readwrite", STANDARD_ACCESS_HIERARCHY), true);
  });

  it("given < required で false", () => {
    assert.equal(hasAccess("readonly", "readwrite", STANDARD_ACCESS_HIERARCHY), false);
  });

  it("given が undefined なら default readonly として扱う", () => {
    // access 省略 = default readonly。readonly 要求は通る、readwrite 要求は通らない
    assert.equal(hasAccess(undefined, "readonly", STANDARD_ACCESS_HIERARCHY), true);
    assert.equal(hasAccess(undefined, "readwrite", STANDARD_ACCESS_HIERARCHY), false);
  });

  it("given が 'deny' なら明示的に拒否 (readonly も通らない)", () => {
    assert.equal(hasAccess("deny", "readonly", STANDARD_ACCESS_HIERARCHY), false);
    assert.equal(hasAccess("deny", "readwrite", STANDARD_ACCESS_HIERARCHY), false);
  });

  it("階層に無い値は最低 (0) 扱い", () => {
    assert.equal(hasAccess("unknown", "readonly", STANDARD_ACCESS_HIERARCHY), false);
  });

  it("apps-script の execute > readwrite > readonly が成り立つ", () => {
    assert.equal(hasAccess("execute", "readwrite", APPS_SCRIPT_HIERARCHY), true);
    assert.equal(hasAccess("execute", "readonly", APPS_SCRIPT_HIERARCHY), true);
    assert.equal(hasAccess("readwrite", "execute", APPS_SCRIPT_HIERARCHY), false);
  });
});

describe("checkDirectAccess", () => {
  const entries: ResourceEntry<StandardAccess>[] = [
    { id: "id-1", name: "ファイル1", access: "readwrite" },
    { id: "id-2", name: "ファイル2", access: "readonly" },
    { id: "id-3", name: "ファイル3" }, // access 省略 = readonly default
  ];

  it("hit + access 十分 → allowed", () => {
    const r = checkDirectAccess(entries, "id-1", "readwrite", STANDARD_ACCESS_HIERARCHY);
    assert.equal(r.allowed, true);
    assert.equal(r.entry?.id, "id-1");
  });

  it("hit + access 不足 → not allowed (entry は返る)", () => {
    const r = checkDirectAccess(entries, "id-2", "readwrite", STANDARD_ACCESS_HIERARCHY);
    assert.equal(r.allowed, false);
    assert.equal(r.entry?.id, "id-2");
    assert.ok(r.reason);
  });

  it("access 省略は readonly default", () => {
    const r = checkDirectAccess(entries, "id-3", "readwrite", STANDARD_ACCESS_HIERARCHY);
    assert.equal(r.allowed, false);
  });

  it("hit せず → not allowed (entry なし)", () => {
    const r = checkDirectAccess(entries, "unknown", "readonly", STANDARD_ACCESS_HIERARCHY);
    assert.equal(r.allowed, false);
    assert.equal(r.entry, undefined);
  });

  it("readonly hit に readonly 要求 → allowed", () => {
    const r = checkDirectAccess(entries, "id-2", "readonly", STANDARD_ACCESS_HIERARCHY);
    assert.equal(r.allowed, true);
  });
});
