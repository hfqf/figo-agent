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
  it("declares write_file parameters including explicit parent directory creation", () => {
    const tool = registryWithWriteTools().listTools().find((tool) => tool.name === "write_file");
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
        createDirs: { type: "boolean", default: false, description: expect.stringContaining("父目录") }
      },
      required: ["path", "content"],
      additionalProperties: false
    });
    expect(tool?.description).toContain("createDirs=true");
  });

  it.each([undefined, false])("does not create missing parents when createDirs=%s", async (createDirs) => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const result = await registryWithWriteTools().execute("write_file", {
      path: "商业化分析/README.md", content: "报告", ...(createDirs === undefined ? {} : { createDirs })
    }, toolContext());
    expect(result).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("ENOENT") });
    await expect(readFile(join(workspace, "商业化分析", "README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows empty content and overwrites an existing file without createDirs", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "note.md"), "before", "utf8");
    const result = await registryWithWriteTools().execute("write_file", { path: "note.md", content: "" }, toolContext());
    expect(result).toMatchObject({ status: "completed", output: { path: "note.md", bytes: 0 } });
    await expect(readFile(join(workspace, "note.md"), "utf8")).resolves.toBe("");
  });

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
