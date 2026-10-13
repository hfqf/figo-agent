import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), "figo-desktop-e2e-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const binary = process.env.FIGO_DESKTOP_BINARY || require("electron");
const env = { ...process.env, FIGO_DESKTOP_SMOKE_WORKSPACE: workspace, FIGO_DESKTOP_SMOKE_CONFIG_ROOT: join(root, "config") };
delete env.ELECTRON_RUN_AS_NODE;

try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, [process.env.FIGO_DESKTOP_BINARY ? "--desktop-smoke" : ".", ...(process.env.FIGO_DESKTOP_BINARY ? [] : ["--desktop-smoke"])], {
      cwd: new URL("..", import.meta.url).pathname, env
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`桌面烟测超时: ${stderr.slice(-1000)}`)); }, 30000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      const marker = stdout.split("\n").find((line) => line.startsWith("FIGO_DESKTOP_SMOKE="));
      if (code !== 0 || !marker) return reject(new Error(`桌面烟测失败 (${code}): ${stderr.slice(-1500)} ${stdout.slice(-500)}`));
      resolve(JSON.parse(marker.slice("FIGO_DESKTOP_SMOKE=".length)));
    });
  });
  if (result.authenticated !== true || result.sqlite !== true || result.workspace !== true || result.staticAsset !== true || result.blankModelKeyBlocked !== true) {
    throw new Error(`桌面烟测结果不完整: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`桌面烟测通过: Electron ${result.electron}, Node ${result.node}, SQLite ${result.sqliteVersion}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
