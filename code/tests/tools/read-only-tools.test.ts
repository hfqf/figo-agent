import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadOnlyPolicy } from "../../src/policy/read-only-policy.js";
import { createReadOnlyTools } from "../../src/tools/read-only-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

async function setupWorkspace(): Promise<void> {
  workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
  await writeFile(join(workspace, "readme.md"), "hello\n项目理解\n", "utf8");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "main.ts"), "console.log('项目理解');\n", "utf8");
  await mkdir(join(workspace, "node_modules"), { recursive: true });
  await writeFile(join(workspace, "node_modules", "skip.js"), "skip", "utf8");
  await mkdir(join(workspace, ".figo-agent"), { recursive: true });
  await writeFile(join(workspace, ".figo-agent", "skip.md"), "skip", "utf8");
}

describe("read-only tools", () => {
  it("lists files while excluding generated and dependency directories", async () => {
    await setupWorkspace();
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace));
    for (const tool of createReadOnlyTools()) registry.register(tool);

    const result = await registry.execute("list_files", { path: "." }, toolContext());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output.files).toContain("readme.md");
      expect(result.output.files).toContain("src/main.ts");
      expect(result.output.files).not.toContain("node_modules/skip.js");
      expect(result.output.files).not.toContain(".figo-agent/skip.md");
    }
  });

  it("reads workspace files and searches matching lines", async () => {
    await setupWorkspace();
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace));
    for (const tool of createReadOnlyTools()) registry.register(tool);

    const readResult = await registry.execute("read_file", { path: "readme.md" }, toolContext());
    expect(readResult.status).toBe("completed");
    if (readResult.status === "completed") {
      expect(readResult.output.content).toContain("项目理解");
    }

    const searchResult = await registry.execute(
      "search_text",
      { query: "项目理解", path: "." },
      toolContext()
    );
    expect(searchResult.status).toBe("completed");
    if (searchResult.status === "completed") {
      expect(searchResult.output.matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "readme.md", line: 2 }),
          expect.objectContaining({ path: "src/main.ts", line: 1 })
        ])
      );
    }
  });

  it("returns system info without leaking environment variables", async () => {
    await setupWorkspace();
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace));
    for (const tool of createReadOnlyTools()) registry.register(tool);

    const result = await registry.execute("system_info", {}, toolContext());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toMatchObject({ workspaceRoot: workspace });
      expect(result.output).toHaveProperty("platform");
      expect(result.output).toHaveProperty("cpuCount");
      expect(result.output).not.toHaveProperty("env");
    }
  });

  it("stats paths, reads many files, and summarizes the workspace", async () => {
    await setupWorkspace();
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf8"
    );
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace));
    for (const tool of createReadOnlyTools()) registry.register(tool);

    const pathStat = await registry.execute("path_stat", { path: "readme.md" }, toolContext());
    expect(pathStat.status).toBe("completed");
    if (pathStat.status === "completed") {
      expect(pathStat.output).toMatchObject({ path: "readme.md", kind: "file" });
    }

    const many = await registry.execute(
      "read_many_files",
      { paths: ["readme.md", "src/main.ts"], maxBytesPerFile: 1000 },
      toolContext()
    );
    expect(many.status).toBe("completed");
    if (many.status === "completed") {
      expect(many.output.files).toHaveLength(2);
      expect(many.output.files[0].content).toContain("项目理解");
    }

    const summary = await registry.execute("workspace_summary", {}, toolContext());
    expect(summary.status).toBe("completed");
    if (summary.status === "completed") {
      expect(summary.output.packageJson?.scripts).toMatchObject({ test: "vitest run" });
      expect(summary.output.files).toContain("readme.md");
    }
  });

  it("returns ToolError when missing or denied by policy", async () => {
    await setupWorkspace();
    const registry = new ToolRegistry(new ReadOnlyPolicy(workspace));
    let executed = false;
    registry.register({
      name: "read_file",
      description: "read",
      execute: async () => {
        executed = true;
        return { status: "completed", output: { content: "bad" } };
      }
    });

    await expect(registry.execute("missing", {}, toolContext())).resolves.toMatchObject({
      status: "failed",
      errorCode: "tool_not_found"
    });
    await expect(
      registry.execute("read_file", { path: "../secret.txt" }, toolContext())
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "path_outside_workspace"
    });
    expect(executed).toBe(false);
  });
});

function toolContext() {
  return {
    sessionId: "ses_1",
    turnId: "turn_1",
    workspaceRoot: workspace
  };
}
