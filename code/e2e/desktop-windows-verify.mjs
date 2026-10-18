import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const { version } = require("../package.json");
const packageDir = join("out", "Figo Agent-win32-x64");
const archive = join(packageDir, "resources", "app.asar");
const executable = join(packageDir, "Figo Agent.exe");
const installer = join("out", "make", "nsis", "win32", "x64", `Figo-Agent-Setup-${version}-x64.exe`);

function peMachine(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString("ascii", 0, 2), "MZ", `缺少 PE 文件头：${path}`);
  const header = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", header, header + 4), "PE\0\0", `PE 签名无效：${path}`);
  return bytes.readUInt16LE(header + 4);
}

assert.equal(peMachine(executable), 0x8664, "应用不是 Windows x64 PE");
assert.equal(JSON.parse(asar.extractFile(archive, "package.json").toString()).version, version);
const entries = asar.listPackage(archive);
assert.deepEqual(readdirSync(join(packageDir, "locales")).filter((name) => name.endsWith(".pak")).sort(), ["en-US.pak", "zh-CN.pak"]);
assert.ok(!entries.some((path) => /\/(?:package-lock\.json|\.npmrc|forge\.config\.cjs|electron-builder\.windows\.cjs)$|^\/scripts(?:\/|$)|\.map$|\.d\.ts$|^\/assets\/onboarding-/.test(path)), "应用包含开发文件或重复原图");
for (const path of ["/dist/desktop/main.js", "/dist/desktop/service.js", "/dist/ui/onboarding-store.js", "/web/dist/index.html",
  "/web/dist/setup.html", "/setup-preload.cjs", "/locales/zh-CN.json", "/assets/figo-agent-logo.png"]) {
  assert.ok(entries.includes(path), `缺少资源：${path}`);
}
for (const prefix of ["onboarding-desktop-v1-", "onboarding-trace-inspector-v1-"]) {
  assert.ok(entries.some((path) => path.startsWith(`/web/dist/assets/${prefix}`) && path.endsWith(".png")), `缺少引导图：${prefix}`);
}
const services = asar.extractFile(archive, "dist/config/model-services.js").toString();
for (const family of ["minimax", "deepseek", "gpt-official", "gpt-relay"]) assert.ok(services.includes(`"${family}"`), `缺少首次服务：${family}`);
const setupBundle = entries.find(path => /^\/web\/dist\/assets\/setup-[^/]+\.js$/.test(path));
assert.ok(setupBundle, "缺少首次配置页脚本");
const setupSource = asar.extractFile(archive, setupBundle.slice(1)).toString();
assert.ok(setupSource.includes("discoverModels") && setupSource.includes("setup-services") && setupSource.includes("setup-model"), "首次页未包含多服务与模型发现交互");
assert.ok(asar.extractFile(archive, "setup-preload.cjs").toString().includes("figo-setup:discover-models"), "缺少受限模型发现 IPC");
assert.ok(!entries.some((path) => /figo-agent\.config\.json|(^|\/)\.figo-agent(\/|$)|(^|\/)(tests|e2e|node_modules)(\/|$)|(^|\/)\.env/.test(path)), "包含本机配置、用户数据或开发依赖");

// 只比较实际值，不输出密钥；不将本机运行配置复制进包。
const localConfig = existsSync("figo-agent.config.json") ? JSON.parse(readFileSync("figo-agent.config.json", "utf8")) : {};
const models = Array.isArray(localConfig.llm) ? localConfig.llm : [localConfig.llm];
const secrets = models.map((model) => model?.apiKey).filter((key) => typeof key === "string" && key.length >= 8);
let scannedTextFiles = 0;
for (const path of entries.filter((path) => /\.(?:js|cjs|mjs|json|html|css|md|map|ts|yml|yaml|txt)$/.test(path))) {
  const content = asar.extractFile(archive, path.slice(1)).toString("utf8");
  assert.ok(!secrets.some((secret) => content.includes(secret)), "包内文本含本机密钥，禁止交付");
  assert.ok(!/sk-(?:cp-)?[a-zA-Z0-9_-]{28,}/.test(content), "包内文本含密钥样式字符串，禁止交付");
  scannedTextFiles++;
}

const result = { version, platform: "win32", arch: "x64", packagedFiles: entries.length, scannedTextFiles,
  onboardingImages: 2, firstRunServices: 4, modelDiscoveryBridge: true, secretMatches: 0, runtimeTest: "not_run_requires_windows" };
if (!process.argv.includes("--app-only")) {
  assert.ok(existsSync(installer) && statSync(installer).size > 1_000_000, "缺少完整安装包");
  assert.ok([0x14c, 0x8664].includes(peMachine(installer)), "安装器不是 Windows PE");
  const { getPath7za } = require("app-builder-lib/out/toolsets/7zip.js");
  const sevenZip = await getPath7za();
  const temporary = mkdtempSync(join(tmpdir(), "figo-win-installer-verify-"));
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  try {
    execFileSync(sevenZip, ["x", "-y", installer, `-o${temporary}`, "$PLUGINSDIR/app-64.7z", "$R0/Uninstall Figo Agent.exe"], { stdio: "pipe", timeout: 120000 });
    assert.ok(existsSync(join(temporary, "$R0/Uninstall Figo Agent.exe")), "缺少卸载程序");
    execFileSync(sevenZip, ["x", "-y", join(temporary, "$PLUGINSDIR/app-64.7z"), `-o${join(temporary, "payload")}`, "resources/app.asar", "Figo Agent.exe"], { stdio: "pipe", timeout: 120000 });
    assert.equal(digest(join(temporary, "payload/resources/app.asar")), digest(archive), "安装器内应用归档与已扫描应用包不一致");
    assert.equal(digest(join(temporary, "payload/Figo Agent.exe")), digest(executable), "安装器内主程序与已检查应用包不一致");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  Object.assign(result, { embeddedPayloadMatches: true, uninstallerIncluded: true });
  Object.assign(result, { installer, installerBytes: statSync(installer).size, sha256: createHash("sha256").update(readFileSync(installer)).digest("hex") });
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
