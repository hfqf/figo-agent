import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/contracts/types.js";
import { ContextBuilder } from "../../src/context/context-builder.js";
import { AgentLoop } from "../../src/loop/agent-loop.js";
import { SqliteMemoryStore } from "../../src/memory/sqlite-memory-store.js";
import { PluginHost } from "../../src/plugin/plugin-host.js";
import { ReadOnlyPolicy } from "../../src/policy/read-only-policy.js";
import { MarkdownReporter } from "../../src/reporter/markdown-reporter.js";
import { ProjectUnderstandingSkill } from "../../src/skill/project-understanding-skill.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { createReadOnlyTools } from "../../src/tools/read-only-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { TraceRecorder } from "../../src/trace/trace-recorder.js";

import { TestDatabases } from "../helpers/test-databases.js";

const databases = new TestDatabases();
let workspace = "";

afterEach(async () => {
  databases.close();
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("project understanding e2e", () => {
  it("uses an explicitly selected skill as evidence and skips it for ordinary analysis", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# Figo Agent\n项目理解", "utf8");
    const storage = databases.track(await StorageManager.init(workspace));
    storage.db
      .prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-10T00:00:00.000Z");
    storage.db
      .prepare("insert into tasks (id, session_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
      .run("task_1", "ses_1", "default", "active", "2026-10-10T00:00:00.000Z", "2026-10-10T00:00:00.000Z");
    storage.db
      .prepare("insert into turns (id, session_id, task_id, input, status, created_at) values (?, ?, ?, ?, ?, ?)")
      .run("turn_1", "ses_1", "task_1", "/skill project-understanding 分析当前项目", "processing", "2026-10-10T00:00:00.000Z");

    const trace = new TraceRecorder(storage);
    const toolRegistry = new ToolRegistry(new ReadOnlyPolicy(workspace), trace);
    for (const tool of createReadOnlyTools()) toolRegistry.register(tool);
    const fakeLlm = new CountingLlm();
    const host = new PluginHost();
    host.register({
      manifest: {
        id: "builtin",
        name: "Builtin",
        version: "0.1.0",
        description: "builtin",
        capabilities: []
      },
      setup: async () => ({
        capabilities: [
          {
            type: "contextSource",
            name: "context-builder",
            value: new ContextBuilder(storage, new SqliteMemoryStore(storage), trace)
          },
          { type: "llmProvider", name: "minimax", value: fakeLlm },
          {
            type: "skill",
            name: "project-understanding-skill",
            value: new ProjectUnderstandingSkill(storage, toolRegistry)
          },
          { type: "tool", name: "registry", value: toolRegistry },
          { type: "reporter", name: "markdown", value: new MarkdownReporter(storage) }
        ]
      })
    });
    await host.setupAll({});

    const loop = new AgentLoop(host, trace);
    const result = await loop.runTurn({
      sessionId: "ses_1",
      taskId: "task_1",
      turnId: "turn_1",
      workspaceRoot: workspace,
      input: "/skill project-understanding 分析当前项目"
    });

    expect(result.status).toBe("completed");
    expect(fakeLlm.calls).toBe(1);
    await expect(
      readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/tasks/task_1/turn_1/context.md"), "utf8")
    ).resolves.toContain("ContextPack");
    await expect(
      readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/tasks/task_1/turn_1/report.md"), "utf8")
    ).resolves.toContain("LLM 摘要");
    expect(result.message).toBe("LLM 摘要");
    expect(fakeLlm.requests[0].messages.at(-1)?.content).toContain("Figo Agent");

    const jsonl = await readFile(
      join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"),
      "utf8"
    );
    expect(jsonl).toContain("turn.processing");
    expect(jsonl).toContain("context.build.started");
    expect(jsonl).toContain("context.item.included");
    expect(jsonl).toContain("context.build.completed");
    expect(jsonl).toContain("memory.search.started");
    expect(jsonl).toContain("memory.search.completed");
    expect(jsonl).toContain("llm.called");
    expect(jsonl).toContain("llm.completed");
    expect(jsonl).toContain("policy.evaluated");
    expect(jsonl).toContain("tool.called");
    expect(jsonl).toContain("tool.completed");
    expect(jsonl).toContain("skill.completed");
    expect(jsonl).toContain("artifact.created");
    expect(jsonl).toContain("turn.completed");

    storage.db.prepare("insert into turns (id, session_id, task_id, input, status, created_at) values (?, ?, ?, ?, ?, ?)")
      .run("turn_2", "ses_1", "task_1", "分析当前项目", "processing", "2026-10-10T00:01:00.000Z");
    const ordinary = await loop.runTurn({
      sessionId: "ses_1", taskId: "task_1", turnId: "turn_2", workspaceRoot: workspace, input: "分析当前项目"
    });
    expect(ordinary.message).toBe("LLM 摘要");
    expect(storage.db.prepare("select count(*) as count from skill_runs").get()).toEqual({ count: 1 });
    expect(fakeLlm.requests[1].messages.at(-1)?.content).not.toContain("项目理解 Skill 的本地预检结果");
  });
});

class CountingLlm implements LLMProvider {
  public calls = 0;
  public requests: LLMRequest[] = [];

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    this.requests.push(request);
    return {
      id: "llm_res_1",
      requestId: request.id,
      content: "LLM 摘要",
      model: request.model,
      finishReason: "stop",
      outputLength: 6,
      durationMs: 1
    };
  }
}
