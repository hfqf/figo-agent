import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const packageDir = join("out", "Figo Agent-darwin-arm64", "Figo Agent.app");
const archive = join(packageDir, "Contents", "Resources", "app.asar");
const binary = join(packageDir, "Contents", "MacOS", "Figo Agent");
const zip = join("out", "make", "zip", "darwin", "arm64", "Figo Agent-darwin-arm64-0.1.0.zip");
assert.ok(existsSync(archive) && existsSync(binary), "macOS app package is missing");
assert.ok(existsSync(zip), "macOS ZIP is missing");
const entries = asar.listPackage(archive);
for (const path of ["/dist/desktop/main.js", "/dist/desktop/service.js", "/web/dist/index.html", "/web/dist/setup.html", "/setup-preload.cjs", "/locales/zh-CN.json"]) {
  assert.ok(entries.includes(path), `missing packaged asset: ${path}`);
}
assert.ok(!entries.some((path) => /figo-agent\.config\.json|(^|\/)\.figo-agent(\/|$)|(^|\/)tests(\/|$)/.test(path)),
  "the package contains local config, user data, or tests");

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
