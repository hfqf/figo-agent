import { describe, expect, it } from "vitest";
import { createId } from "../src/utils/id.js";
import { formatShanghaiTime, nowShanghaiTime } from "../src/utils/clock.js";

describe("utils", () => {
  it("creates prefixed ids", () => {
    expect(createId("ses")).toMatch(/^ses_/);
  });

  it("creates millisecond Shanghai timestamps for SQLite", () => {
    expect(formatShanghaiTime(new Date("2026-10-11T11:26:44.601Z"))).toBe("2026-10-11 19:26:44.601");
    expect(nowShanghaiTime()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});
