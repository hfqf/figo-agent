import { describe, expect, it } from "vitest";
import { verifySqliteRuntime } from "../../src/desktop/runtime-check.js";

describe("desktop SQLite runtime", () => {
  it("writes and reads memory and file-backed databases", async () => {
    const result = await verifySqliteRuntime();
    expect(result.node).toMatch(/^v\d+\./);
    expect(result.sqlite).toMatch(/^\d+\./);
  });
});
