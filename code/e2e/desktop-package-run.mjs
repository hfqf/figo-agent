import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = process.argv[2];
if (!["desktop-workbench.pw.mjs", "desktop-real-model.pw.mjs", "desktop-active-exit.pw.mjs", "desktop-first-run.pw.mjs"].includes(script)) {
  throw new Error("未指定桌面安装包验收脚本。");
}
const zip = join("out", "make", "zip", "darwin", "arm64", "Figo Agent-darwin-arm64-0.1.0.zip");
if (!existsSync(zip)) throw new Error("先执行 npm run desktop:make 生成 macOS arm64 ZIP。");
const extracted = await mkdtemp(join(tmpdir(), "figo-desktop-package-test-"));
try {
  execFileSync("unzip", ["-q", zip, "-d", extracted], { stdio: "ignore" });
  const binary = join(extracted, "Figo Agent.app", "Contents", "MacOS", "Figo Agent");
  if (!existsSync(binary)) throw new Error("ZIP 缺少桌面可执行文件。");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join("e2e", script)], {
      env: { ...process.env, FIGO_DESKTOP_BINARY: binary }, stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`安装包验收失败，退出码 ${code}。`)));
  });
} finally { await rm(extracted, { recursive: true, force: true }); }
