import { describe, expect, it } from "vitest";
import { createId } from "../src/utils/id.js";
import { nowIso } from "../src/utils/clock.js";

describe("utils", () => {
  it("creates prefixed ids", () => {
    expect(createId("ses")).toMatch(/^ses_/);
  });

  it("creates ISO timestamps", () => {
    expect(new Date(nowIso()).toString()).not.toBe("Invalid Date");
  });
});
