import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultRuntimeConfig } from "../../src/config/runtime-config.js";
import { createBuiltinPluginHost } from "../../src/plugin/builtin-plugins.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

let workspace = "";
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("builtin LLM capabilities", () => {
  it("registers enabled model ids and omits disabled entries", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-llm-plugin-"));
    const storage = await StorageManager.init(workspace);
    const config = {
      ...defaultRuntimeConfig,
      llm: [
        defaultRuntimeConfig.llm[0],
        { id: "gpt-relay", enabled: true, provider: "openai-compatible" as const, apiKey: "", baseUrl: "https://gpt.example/v1", model: "gpt-5.6-sol" },
        { id: "disabled", enabled: false, provider: "openai-compatible" as const, apiKey: "", baseUrl: "https://disabled.example/v1", model: "unused" }
      ]
    };
    const host = createBuiltinPluginHost(storage, undefined, undefined, config);
    await host.setupAll({});
    expect(host.getCapability("llmProvider", "minimax")).toBeTruthy();
    expect(host.getCapability("llmProvider", "gpt-relay")).toBeTruthy();
    expect(host.getCapability("llmProvider", "disabled")).toBeUndefined();
    storage.db.close();
  });
});
