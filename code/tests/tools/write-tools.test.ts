import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlledToolPolicy } from "../../src/policy/controlled-tool-policy.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { createWriteTools } from "../../src/tools/write-tools.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("write tools", () => {
  it("writes files inside workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const registry = registryWithWriteTools();

    const result = await registry.execute(
      "write_file",
      { path: "docs/note.md", content: "hello v1.2", createDirs: true },
      toolContext()
    );

    expect(result.status).toBe("completed");
    await expect(readFile(join(workspace, "docs", "note.md"), "utf8")).resolves.toBe("hello v1.2");
  });

  it("applies structured text patches inside workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "readme.md"), "hello v1.1\n", "utf8");
    const registry = registryWithWriteTools();

    const result = await registry.execute(
      "apply_patch",
      {
        patches: [{ path: "readme.md", oldText: "v1.1", newText: "v1.2" }]
      },
      toolContext()
    );

    expect(result.status).toBe("completed");
    await expect(readFile(join(workspace, "readme.md"), "utf8")).resolves.toBe("hello v1.2\n");
  });

  it("denies writes outside workspace before execution", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const registry = registryWithWriteTools();

    await expect(
      registry.execute("write_file", { path: "../outside.txt", content: "bad" }, toolContext())
    ).resolves.toMatchObject({ status: "failed", errorCode: "path_outside_workspace" });
  });
});

function registryWithWriteTools(): ToolRegistry {
  const registry = new ToolRegistry(new ControlledToolPolicy(workspace));
  for (const tool of createWriteTools()) registry.register(tool);
  return registry;
}

function toolContext() {
  return {
    sessionId: "ses_1",
    taskId: "task_1",
    turnId: "turn_1",
    workspaceRoot: workspace
  };
}
