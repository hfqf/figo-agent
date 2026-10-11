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
            includeProjectDocs: true,
            projectDocPaths: ["AGENTS.MD"],
            maxTaskHistoryTurns: 3,
            includeMemory: false
          },
          tools: {
            maxToolRounds: 2,
            allowed: ["system_info", "read_file"]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const config = await loadRuntimeConfig(workspace);

    expect(config.llm.apiKey).toBe("json-key");
    expect(config.llm.baseUrl).toBe("https://json.example/v1");
    expect(config.context.includeProjectDocs).toBe(true);
    expect(config.context.projectDocPaths).toEqual(["AGENTS.MD"]);
    expect(config.context.maxTaskHistoryTurns).toBe(3);
    expect(config.context.includeMemory).toBe(false);
    expect(config.context.compaction.autoEnabled).toBe(true);
    expect(config.tools.maxToolRounds).toBe(2);
    expect(config.tools.allowed).toEqual(["system_info", "read_file"]);
  });

  it("uses code defaults when the unified JSON config does not exist", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));

    const config = await loadRuntimeConfig(workspace);

    expect(config.context.includeProjectDocs).toBe(false);
    expect(config.context.includeMemory).toBe(true);
    expect(config.context.compaction.turnThreshold).toBe(12);
    expect(config.llm.model).toBe("MiniMax-M3");
    expect(config.tools.maxToolRounds).toBe(3);
    expect(config.tools.allowed).toContain("system_info");
  });
});
