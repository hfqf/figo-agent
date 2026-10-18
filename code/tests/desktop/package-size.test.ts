import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const config = require(resolve("forge.config.cjs"));
let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("桌面包体积边界", () => {
  it("仅收运行必需内容，去掉开发配置和原始引导图，但保留构建后图片与许可", () => {
    const ignore = config.packagerConfig.ignore;
    for (const path of ["/package-lock.json", "/.npmrc", "/scripts", "/forge.config.cjs", "/electron-builder.windows.cjs",
      "/web/src", "/web/tsconfig.json", "/assets/onboarding-desktop-v1.png", "/assets/onboarding-trace-inspector-v1.png", "/dist/version.d.ts", "/dist/version.js.map",
      "/dist/figo-agent.config.json", "/dist/node_modules/secret.js", "/web/dist/.env", "/third-party/.figo-agent/data.db"]) {
      expect(ignore(path), path).toBe(true);
    }
    for (const path of ["", "/", "/package.json", "/setup-preload.cjs", "/dist", "/dist/desktop", "/dist/desktop/main.js", "/dist/context/pi-summary.js",
      "/assets", "/assets/figo-agent-logo.png", "/web", "/web/dist", "/web/dist/assets", "/web/dist/index.html", "/web/dist/assets/onboarding-desktop-v1-hash.png",
      "/locales", "/locales/zh-CN.json", "/locales/pi-summary.zh-CN.json", "/third-party", "/third-party/pi/LICENSE"]) {
      expect(ignore(path), path).toBe(false);
    }
  });

  it("Windows 仅裁剪语言包，保留中文、英文及非语言文件", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-size-win-"));
    await mkdir(join(root, "locales"));
    for (const name of ["en-US.pak", "zh-CN.pak", "ja.pak", "fr.pak", "metadata.txt"]) await writeFile(join(root, "locales", name), name);
    await writeFile(join(root, "icudtl.dat"), "icu");
    await writeFile(join(root, "Figo Agent.exe"), "runtime");
    expect(config.packagerConfig.afterExtract).toHaveLength(1);
    await config.packagerConfig.afterExtract[0]({ buildPath: root, platform: "win32" });
    expect((await readdir(join(root, "locales"))).sort()).toEqual(["en-US.pak", "metadata.txt", "zh-CN.pak"]);
    expect(await readFile(join(root, "Figo Agent.exe"), "utf8")).toBe("runtime");
    expect(await readFile(join(root, "icudtl.dat"), "utf8")).toBe("icu");
  });

  it("Mac 仅裁剪 framework 本地化，中文和英文的性别变体也保留", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-size-mac-"));
    const resources = join(root, "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources");
    await mkdir(resources, { recursive: true });
    for (const name of ["en.lproj", "en_NEUTER.lproj", "zh_CN.lproj", "zh_CN_FEMININE.lproj", "ja.lproj", "fr_FEMININE.lproj"]) {
      await mkdir(join(resources, name)); await writeFile(join(resources, name, "locale.pak"), name);
    }
    await writeFile(join(resources, "resources.pak"), "runtime resources");
    expect(config.packagerConfig.afterExtract).toHaveLength(1);
    await config.packagerConfig.afterExtract[0]({ buildPath: root, platform: "darwin" });
    expect((await readdir(resources)).sort()).toEqual(["en.lproj", "en_NEUTER.lproj", "resources.pak", "zh_CN.lproj", "zh_CN_FEMININE.lproj"]);
  });

  it("必要语言缺失时拒绝裁剪，不静默删除剩余文件", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-size-missing-"));
    await mkdir(join(root, "locales")); await writeFile(join(root, "locales/fr.pak"), "French");
    expect(config.packagerConfig.afterExtract).toHaveLength(1);
    await expect(config.packagerConfig.afterExtract[0]({ buildPath: root, platform: "win32" })).rejects.toThrow();
    expect(await readFile(join(root, "locales/fr.pak"), "utf8")).toBe("French");
  });
});
