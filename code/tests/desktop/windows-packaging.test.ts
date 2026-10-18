import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

describe("Windows 安装包配置", () => {
  it("仅新增 x64 NSIS 入口，复用 Forge 应用包，不替换 Mac 入口或维护第二个版本", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(manifest.scripts["desktop:make:win"]).toContain("--platform=win32 --arch=x64");
    expect(manifest.scripts["desktop:make:win"]).toContain("--prepackaged");
    expect(manifest.scripts["desktop:make"]).toContain("electron-forge make");
    expect(existsSync(resolve(root, "electron-builder.windows.cjs"))).toBe(true);
    const config = require(resolve(root, "electron-builder.windows.cjs"));
    expect(config.appId).toBe("cn.figo.agent");
    expect(config).not.toHaveProperty("extraMetadata.version");
    expect(config.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(config.win.signExecutable).toBe(false);
    expect(config.artifactName).toContain("${version}");
    expect(config.publish).toBeNull();
  });

  it("向导允许选择路径，默认按用户安装，卸载不删除配置和用户数据", () => {
    expect(existsSync(resolve(root, "electron-builder.windows.cjs"))).toBe(true);
    const config = require(resolve(root, "electron-builder.windows.cjs"));
    expect(config.nsis).toMatchObject({ oneClick: false, perMachine: false, selectPerMachineByDefault: false,
      allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false, installerLanguages: ["zh_CN"] });
  });

  it("Windows 与 Mac 共用品牌标识，ICO 包含多尺寸图像，敏感文件仍被排除", () => {
    const path = resolve(root, "assets/figo-agent.ico");
    expect(existsSync(path)).toBe(true);
    const icon = readFileSync(path);
    expect(icon.readUInt16LE(0)).toBe(0); expect(icon.readUInt16LE(2)).toBe(1);
    expect(icon.readUInt16LE(4)).toBeGreaterThanOrEqual(3);
    const forge = require(resolve(root, "forge.config.cjs"));
    for (const path of ["/figo-agent.config.json", "/.figo-agent/onboarding.db", "/.env", "/tests/secret.ts"]) {
      expect(forge.packagerConfig.ignore(path)).toBe(true);
    }
    expect(forge.packagerConfig.ignore("/web/dist/assets/onboarding-desktop-v1-hash.png")).toBe(false);
  });
});
