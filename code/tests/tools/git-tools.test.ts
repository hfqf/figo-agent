import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ControlledToolPolicy } from "../../src/policy/controlled-tool-policy.js";
import { createGitTools } from "../../src/tools/git-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const execFileAsync = promisify(execFile);
let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("git tools", () => {
  it("supports status, diff, log, add, and commit", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await execFileAsync("git", ["init"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Figo Agent Test"], { cwd: workspace });
    await writeFile(join(workspace, "readme.md"), "hello\n", "utf8");

    const registry = new ToolRegistry(new ControlledToolPolicy(workspace));
    for (const tool of createGitTools()) registry.register(tool);

    const status = await registry.execute("git_status", {}, toolContext());
    expect(status.status).toBe("completed");
    if (status.status === "completed") {
      expect(status.output.stdout).toContain("readme.md");
    }

    await expect(
      registry.execute("git_add", { paths: ["readme.md"] }, toolContext())
    ).resolves.toMatchObject({ status: "completed", output: { exitCode: 0 } });
    await expect(
      registry.execute("git_commit", { message: "test: initial commit" }, toolContext())
    ).resolves.toMatchObject({ status: "completed", output: { exitCode: 0 } });

    const log = await registry.execute("git_log", { maxCount: 1 }, toolContext());
    expect(log.status).toBe("completed");
    if (log.status === "completed") {
      expect(log.output.stdout).toContain("test: initial commit");
    }

    await writeFile(join(workspace, "readme.md"), "hello v1.2\n", "utf8");
    const diff = await registry.execute("git_diff", {}, toolContext());
    expect(diff.status).toBe("completed");
    if (diff.status === "completed") {
      expect(diff.output.stdout).toContain("hello v1.2");
    }
  });
  it.each(["note with spaces.txt", "note's & %PATH% $value.txt"])("passes Git arguments literally for %s", async (filename) => {
    workspace = await mkdtemp(join(tmpdir(), "figo-git-literal-"));
    await execFileAsync("git", ["init"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Figo Agent Test"], { cwd: workspace });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: workspace });
    await writeFile(join(workspace, filename), "literal\n");
    const registry = new ToolRegistry(new ControlledToolPolicy(workspace));
    for (const tool of createGitTools()) registry.register(tool);
    const message = 'test: "quotes" & %PATH% $HOME `literal` and apostrophe\'s';
    await expect(registry.execute("git_add", { paths: [filename] }, toolContext()))
      .resolves.toMatchObject({ status: "completed", output: { exitCode: 0 } });
    await expect(registry.execute("git_commit", { message }, toolContext()))
      .resolves.toMatchObject({ status: "completed", output: { exitCode: 0 } });
    const log = await execFileAsync("git", ["log", "-1", "--format=%B"], { cwd: workspace });
    expect(log.stdout.trim()).toBe(message);
    const files = await execFileAsync("git", ["ls-tree", "--name-only", "HEAD"], { cwd: workspace });
    expect(files.stdout.trim()).toBe(filename);
  });
});

function toolContext() {
  return {
    sessionId: "ses_1",
    taskId: "task_1",
    turnId: "turn_1",
    workspaceRoot: workspace
  };
}
