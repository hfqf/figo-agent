import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/runtime-config.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("loadRuntimeConfig", () => {
  it("loads configured behavior limits and locale", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({
      locale: "zh-CN",
      agent: { toolResultPreviewChars: 900, toolResultBatchChars: 6000, protocolRepairAttempts: 1, noProgressRepeatLimit: 2 },
      storage: { sqliteBusyTimeoutMs: 2500 },
      tools: { defaults: { readManyMaxFiles: 1, commandTimeoutMs: 2500 } },
      web: { fileBrowser: { searchMinChars: 4, maxDirectoryEntries: 9 }, terminal: { historyEntries: 1, maxCommandChars: 99 } }
    }));
    const config = await loadRuntimeConfig(workspace);
    expect(config.agent.toolResultPreviewChars).toBe(900);
    expect(config.agent).toMatchObject({ toolResultBatchChars: 6000, protocolRepairAttempts: 1, noProgressRepeatLimit: 2 });
    expect(config.storage.sqliteBusyTimeoutMs).toBe(2500);
    expect(config.tools.defaults).toMatchObject({ readManyMaxFiles: 1, commandTimeoutMs: 2500 });
    expect(config.web.fileBrowser).toMatchObject({ searchMinChars: 4, maxDirectoryEntries: 9 });
    expect(config.web.terminal).toMatchObject({ historyEntries: 1, maxCommandChars: 99 });
  });

  it("rejects unsupported locale and invalid behavior limits", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const path = join(workspace, "figo-agent.config.json");
    await writeFile(path, JSON.stringify({ locale: "en-US" }));
    await expect(loadRuntimeConfig(workspace)).rejects.toThrow("不支持的语言");
    await writeFile(path, JSON.stringify({ web: { fileBrowser: { searchMinChars: 10, searchMaxChars: 2 } } }));
    await expect(loadRuntimeConfig(workspace)).rejects.toThrow("文件区配置范围无效");
    await writeFile(path, JSON.stringify({ storage: { sqliteBusyTimeoutMs: -1 } }));
    await expect(loadRuntimeConfig(workspace)).rejects.toThrow("storage.sqliteBusyTimeoutMs");
  });
  it("normalizes invalid compaction thresholds and honors the automatic switch", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({
      context: { maxTaskHistoryTurns: 20, compaction: { autoEnabled: false, turnThreshold: 3, charThreshold: 0, summaryMaxChars: -1 } }
    }));
    const config = await loadRuntimeConfig(workspace);
    expect(config.context.compaction).toMatchObject({ autoEnabled: false, turnThreshold: 21, charThreshold: 24000, summaryMaxChars: 12000 });
  });
  it("loads runtime controls from figo-agent.config.json", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(
      join(workspace, "figo-agent.config.json"),
      JSON.stringify(
        {
          version: 1,
          llm: {
            provider: "minimax",
            apiKey: "json-key",
            baseUrl: "https://json.example/v1",
            model: "MiniMax-M3"
          },
          context: {
            maxTaskHistoryTurns: 3,
            includeMemory: false
          },
          tools: {
            allowed: ["system_info", "read_file"]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const config = await loadRuntimeConfig(workspace);

    expect(config.activeModelId).toBe("minimax");
    expect(config.llm).toEqual([{ id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "json-key", baseUrl: "https://json.example/v1", model: "MiniMax-M3" }]);
    expect(config.context.maxTaskHistoryTurns).toBe(3);
    expect(config.context.includeMemory).toBe(false);
    expect(config.context.compaction.autoEnabled).toBe(true);
    expect(config.tools.allowed).toEqual(["system_info", "read_file"]);
  });

  it("uses code defaults when the unified JSON config does not exist", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));

    const config = await loadRuntimeConfig(workspace);

    expect(config.context.includeMemory).toBe(true);
    expect(config.storage.sqliteBusyTimeoutMs).toBe(5000);
    expect(config.context.compaction.turnThreshold).toBe(12);
    expect(config.activeModelId).toBe("minimax");
    expect(config.llm[0].model).toBe("MiniMax-M3");
    expect(config.tools.allowed).toContain("system_info");
    expect(config.web.requireAccessCode).toBe(true);
  });

  it("allows the local web access-code prompt to be disabled in unified JSON", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({ web: { requireAccessCode: false } }));
    const config = await loadRuntimeConfig(workspace);
    expect(config.web.requireAccessCode).toBe(false);
  });

  it("loads multiple models and selects the explicitly active enabled model", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({
      activeModelId: "gpt-relay",
      llm: [
        { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "mini-key", baseUrl: "https://mini.example/v1", model: "MiniMax-M3" },
        { id: "gpt-relay", enabled: true, provider: "openai-compatible", apiKey: "gpt-key", baseUrl: "https://code.aicodeme.xyz/v1", model: "gpt-5.6-sol" },
        { id: "disabled", enabled: false, provider: "openai-compatible", apiKey: "", baseUrl: "https://disabled.example/v1", model: "unused" }
      ]
    }));
    const config = await loadRuntimeConfig(workspace);
    expect(config.llm).toHaveLength(3);
    expect(config.activeModelId).toBe("gpt-relay");
    expect(config.llm.find((entry) => entry.id === config.activeModelId)?.model).toBe("gpt-5.6-sol");
  });

  it.each([
    ["disabled", [
      { id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://mini.example/v1", model: "MiniMax-M3" },
      { id: "gpt-relay", enabled: false, provider: "openai-compatible", apiKey: "", baseUrl: "https://gpt.example/v1", model: "gpt-5.6-sol" }
    ], "gpt-relay"],
    ["unknown", [{ id: "minimax", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://mini.example/v1", model: "MiniMax-M3" }], "missing"],
    ["duplicate", [
      { id: "same", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://one.example/v1", model: "one" },
      { id: "same", enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://two.example/v1", model: "two" }
    ], "same"]
  ])("rejects %s model configuration", async (_case, llm, activeModelId) => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({ activeModelId, llm }));
    await expect(loadRuntimeConfig(workspace)).rejects.toThrow();
  });

  it("rejects an unsupported adapter instead of silently selecting the default", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "figo-agent.config.json"), JSON.stringify({
      activeModelId: "other",
      llm: [{ id: "other", enabled: true, provider: "other-api", apiKey: "", baseUrl: "https://other.example/v1", model: "other" }]
    }));
    await expect(loadRuntimeConfig(workspace)).rejects.toThrow("provider 不受支持");
  });

  it("rejects malformed JSON instead of silently using MiniMax", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "figo-agent.config.json"), "{ broken");
    await expect(loadRuntimeConfig(workspace)).rejects.toThrow();
  });
});
