import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

describe("product version", () => {
  it("uses a semantic product version, including optional prerelease labels", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("keeps lock metadata synchronized with the application manifest", () => {
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""].version).toBe(manifest.version);
  });

  it("reads the runtime version from the application manifest", async () => {
    const { appVersion } = await import("../src/version.js");
    expect(appVersion).toBe(manifest.version);
  });
});
