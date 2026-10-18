import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { renderStartup } from "../../src/cli/renderer.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("CLI version", () => {
  it.each(["--version", "-v"])("prints %s without loading the kernel or creating user data", async (flag) => {
    root = await mkdtemp(join(tmpdir(), "figo-version-cli-"));
    const code = join(root, "code");
    await mkdir(code);
    await cp(new URL("../../src", import.meta.url), join(code, "src"), { recursive: true });
    await cp(new URL("../../locales", import.meta.url), join(code, "locales"), { recursive: true });
    await cp(new URL("../../package.json", import.meta.url), join(code, "package.json"));
    // 隔离副本即使遇到旧入口也不会触碰真实工作区；stdin 关闭避免旧 REPL 挂起。
    const child = execFileAsync(process.execPath, ["--import", require.resolve("tsx/esm"), join(code, "src/cli/main.ts"), flag],
      { cwd: tmpdir(), timeout: 10000 });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    expect(stdout.trim()).toBe(`Figo Agent ${manifest.version}`);
    expect(stderr).not.toContain("SQLite");
    await expect(readFile(join(root, ".figo-agent/figo-agent.db"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(code, ".figo-agent/figo-agent.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("includes the product version in the startup banner", () => {
    expect(renderStartup("ses_test")).toContain(`Figo Agent ${manifest.version}`);
    expect(renderStartup("ses_test")).toContain("ses_test");
  });
});
