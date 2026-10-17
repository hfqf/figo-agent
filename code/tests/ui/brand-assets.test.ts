import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const readAsset = (path: string) => existsSync(resolve(root, path)) ? readFileSync(resolve(root, path)) : Buffer.alloc(0);

describe("品牌图标发布资源", () => {
  it.each([["figo-agent-logo.png", 512], ["figo-agent-favicon.png", 64]] as const)("%s 是指定尺寸的透明 PNG", (name, size) => {
    const image = readAsset(`assets/${name}`);
    expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(image.readUInt32BE(16)).toBe(size);
    expect(image.readUInt32BE(20)).toBe(size);
    expect(image[25]).toBe(6);
  });

  it("macOS 图标是完整 ICNS，Forge 引用相同资源", () => {
    const image = readAsset("assets/figo-agent.icns");
    expect(image.subarray(0, 4).toString()).toBe("icns");
    expect(image.readUInt32BE(4)).toBe(image.length);
    const config = require(resolve(root, "forge.config.cjs"));
    expect(config.packagerConfig.icon).toBe(resolve(root, "assets/figo-agent.icns"));
  });

  it.each(["index.html", "setup.html"])("%s 配置共享品牌 favicon", (name) => {
    expect(readFileSync(resolve(root, "web", name), "utf8"))
      .toMatch(/<link\s+rel="icon"[^>]*href="\.\.\/assets\/figo-agent-favicon\.png"/);
  });
});
