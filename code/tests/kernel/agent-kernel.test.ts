import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("AgentKernel", () => {
  it("loads config from the code directory while keeping storage at the workspace root", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const configRoot = join(workspace, "code");
    await mkdir(configRoot);
    await writeFile(join(configRoot, "figo-agent.config.json"), JSON.stringify({
      activeModelId: "disabled",
      llm: [{ id: "disabled", enabled: false, provider: "openai-compatible", apiKey: "", baseUrl: "https://disabled.example/v1", model: "unused" }]
    }));

    await expect(AgentKernel.start({ workspaceRoot: workspace, configRoot })).rejects.toThrow("已关闭");
    await expect(stat(join(workspace, ".figo-agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a disabled active model before creating storage", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({
      activeModelId: "disabled",
      llm: [{ id: "disabled", enabled: false, provider: "openai-compatible", apiKey: "", baseUrl: "https://disabled.example/v1", model: "unused" }]
    }));
    await expect(AgentKernel.start({ workspaceRoot: workspace })).rejects.toThrow("已关闭");
    await expect(stat(join(workspace, ".figo-agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes turns and task compaction through the selected enabled model", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({
      activeModelId: "gpt-relay",
      llm: [
        { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "mini-key", baseUrl: "https://mini.example/v1", model: "MiniMax-M3" },
        { id: "gpt-relay", enabled: true, provider: "openai-compatible", apiKey: "gpt-key", baseUrl: "https://gpt.example/v1", model: "gpt-5.6-sol" },
        { id: "disabled", enabled: false, provider: "openai-compatible", apiKey: "disabled-key", baseUrl: "https://disabled.example/v1", model: "unused" }
      ]
    }));
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; model: string }> = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
      calls.push({ url: String(url), model: body.model });
      let content = "普通回答";
      if (body.messages[0].content.includes("将 Task 历史压缩")) {
        const payload = JSON.parse(body.messages[1].content) as { turns: Array<{ id: string }> };
        const id = payload.turns[0].id;
        content = JSON.stringify({ goal: { text: "第一轮目标", sourceTurnIds: [id] }, facts: [], decisions: [], completedWork: [], openIssues: [], constraints: [], sourceTurnIds: [id] });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
    };
    try {
      const kernel = await AgentKernel.start({ workspaceRoot: workspace });
      await kernel.submitTurn("第一轮目标");
      await kernel.submitTurn("第二轮内容");
      expect((await kernel.handleCommand("/compact")).status).toBe("completed");
      expect(calls).toHaveLength(3);
      expect(calls).toEqual(Array(3).fill({ url: "https://gpt.example/v1/chat/completions", model: "gpt-5.6-sol" }));
      const captures = kernel.storage.db.prepare("select provider, model, purpose from llm_http_captures order by created_at").all() as Array<{ provider: string; model: string; purpose: string }>;
      expect(captures).toHaveLength(3);
      expect(captures.every((capture) => capture.provider === "gpt-relay" && capture.model === "gpt-5.6-sol")).toBe(true);
      expect(captures.map((capture) => capture.purpose)).toContain("task_compaction");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs /compact without creating a user turn and keeps history if the model cannot summarize", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    await kernel.submitTurn("第一轮");
    await kernel.submitTurn("第二轮");
    const before = kernel.storage.db.prepare("select count(*) as count from turns").get() as { count: number };
    const result = await kernel.handleCommand("/compact");
    expect(result.status).toBe("failed");
    expect(result.message).toContain("compaction summary is not JSON");
    expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toMatchObject(before);
    expect(kernel.storage.db.prepare("select count(*) as count from task_compaction_checkpoints").get()).toMatchObject({ count: 0 });
    expect(kernel.storage.db.prepare("select count(*) as count from trace_events where type = 'compaction.failed'").get()).toMatchObject({ count: 1 });
  });
  it("starts a session, submits a turn through AgentLoop, and shuts down", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\n项目理解", "utf8");

    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    expect(kernel.session.id).toMatch(/^ses_/);
    expect(
      kernel.storage.db.prepare("select id from sessions where id = ?").get(kernel.session.id)
    ).toBeTruthy();

    const result = await kernel.submitTurn("理解当前项目");
    expect(result.status).toBe("completed");
    expect(
      kernel.storage.db.prepare("select status from turns where id = ?").get(result.turnId)
    ).toMatchObject({ status: "completed" });

    await kernel.shutdown();
    expect(
      kernel.storage.db.prepare("select status from sessions where id = ?").get(kernel.session.id)
    ).toMatchObject({ status: "ended" });

    const jsonl = await readFile(
      join(workspace, ".figo-agent/artifacts/sessions", kernel.session.id, "trace.jsonl"),
      "utf8"
    );
    expect(jsonl).toContain("session.started");
    expect(jsonl).toContain("plugin.registered");
    expect(jsonl).toContain("plugin.ready");
    expect(jsonl).toContain("capability.registered");
    expect(jsonl).toContain("turn.received");
    expect(jsonl).toContain("turn.completed");
  });

  it("rejects ordinary input for a paused task and records task.command.rejected", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\n项目理解", "utf8");

    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    await kernel.handleCommand("/task pause");
    const task = kernel.storage.db.prepare("select id from tasks where status = ?").get("paused") as {
      id: string;
    };

    await expect(kernel.submitTurn("暂停后不应接收")).rejects.toThrow(
      "当前 Task 状态为 paused，不能接收普通输入。"
    );
    expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toMatchObject({
      count: 0
    });
    expect(
      kernel.storage.db
        .prepare("select type, task_id from trace_events where type = ?")
        .get("task.command.rejected")
    ).toMatchObject({ type: "task.command.rejected", task_id: task.id });
  });

  it("creates a new task for ordinary input after finishing the current task", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "AGENTS.MD"), "中文文档原则", "utf8");
    await writeFile(join(workspace, "readme.md"), "# 项目\n项目理解", "utf8");

    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const firstTask = kernel.storage.db.prepare("select id from tasks").get() as { id: string };
    await kernel.handleCommand("/task finish");

    const result = await kernel.submitTurn("理解当前项目");
    expect(result.status).toBe("completed");
    const turn = kernel.storage.db.prepare("select task_id from turns where id = ?").get(result.turnId) as {
      task_id: string;
    };
    expect(turn.task_id).not.toBe(firstTask.id);
    expect(kernel.storage.db.prepare("select status from tasks where id = ?").get(firstTask.id)).toMatchObject({
      status: "completed"
    });
  });
});
