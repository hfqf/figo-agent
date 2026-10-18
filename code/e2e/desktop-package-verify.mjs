import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const asar = require("@electron/asar");
const packageDir = join("out", "Figo Agent-darwin-arm64", "Figo Agent.app");
const archive = join(packageDir, "Contents", "Resources", "app.asar");
const binary = join(packageDir, "Contents", "MacOS", "Figo Agent");
const zip = join("out", "make", "zip", "darwin", "arm64", `Figo Agent-darwin-arm64-${version}.zip`);
assert.ok(existsSync(archive) && existsSync(binary), "macOS app package is missing");
assert.ok(existsSync(zip), "macOS ZIP is missing");
assert.equal(JSON.parse(asar.extractFile(archive, "package.json").toString()).version, version, "packaged manifest version must match source");
const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(packageDir, "Contents/Info.plist")], { encoding: "utf8" }));
assert.equal(plist.CFBundleShortVersionString, version, "macOS version must match source");
const entries = asar.listPackage(archive);
for (const path of ["/dist/desktop/main.js", "/dist/desktop/service.js", "/web/dist/index.html", "/web/dist/setup.html", "/setup-preload.cjs", "/locales/zh-CN.json"]) {
  assert.ok(entries.includes(path), `missing packaged asset: ${path}`);
}
assert.ok(!entries.some((path) => /figo-agent\.config\.json|(^|\/)\.figo-agent(\/|$)|(^|\/)tests(\/|$)/.test(path)),
  "the package contains local config, user data, or tests");
assert.ok(!entries.some((path) => /\/(?:package-lock\.json|\.npmrc|forge\.config\.cjs|electron-builder\.windows\.cjs)$|^\/scripts(?:\/|$)|\.map$|\.d\.ts$|^\/assets\/onboarding-/.test(path)), "应用包含开发文件或重复原图");
for (const prefix of ["onboarding-desktop-v1-", "onboarding-trace-inspector-v1-"]) {
  assert.ok(entries.some((path) => path.startsWith(`/web/dist/assets/${prefix}`) && path.endsWith(".png")), "缺少构建后的引导图");
}
const localeRoot = join(packageDir, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources");
const localeNames = readdirSync(localeRoot).filter((name) => name.endsWith(".lproj"));
assert.ok(localeNames.includes("en.lproj") && localeNames.includes("zh_CN.lproj"));
assert.ok(localeNames.every((name) => /^(?:en|en_US|zh_CN)(?:_(?:FEMININE|MASCULINE|NEUTER))?\.lproj$/.test(name)), "存在未裁剪的 Electron 语言");

const extracted = await mkdtemp(join(tmpdir(), "figo-desktop-zip-"));
try {
  execFileSync("unzip", ["-q", zip, "-d", extracted], { stdio: "ignore" });
  const extractedBinary = join(extracted, "Figo Agent.app", "Contents", "MacOS", "Figo Agent");
  assert.ok(existsSync(extractedBinary), "ZIP does not contain the desktop executable");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["e2e/desktop-smoke.mjs"], {
      env: { ...process.env, FIGO_DESKTOP_BINARY: extractedBinary }, stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`packaged smoke failed: ${code}`)));
  });
} finally { await rm(extracted, { recursive: true, force: true }); }
process.stdout.write("安装包资源、敏感文件与 ZIP 解压运行检查通过。\n");
