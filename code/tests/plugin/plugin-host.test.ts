import { describe, expect, it } from "vitest";
import { PluginHost } from "../../src/plugin/plugin-host.js";

describe("PluginHost", () => {
  it("registers capabilities and rejects duplicate plugin ids and capabilities", async () => {
    const host = new PluginHost();
    host.register({
      manifest: {
        id: "p1",
        name: "Plugin 1",
        version: "0.1.0",
        description: "test",
        capabilities: [
          { type: "tool", name: "read_file", description: "read" },
          { type: "skill", name: "project-understanding-skill", description: "skill" },
          { type: "llmProvider", name: "minimax", description: "llm" },
          { type: "policy", name: "read-only", description: "policy" }
        ]
      },
      setup: async () => ({
        capabilities: [
          { type: "tool", name: "read_file", value: { name: "read_file" } },
          { type: "skill", name: "project-understanding-skill", value: { name: "skill" } },
          { type: "llmProvider", name: "minimax", value: { name: "minimax" } },
          { type: "policy", name: "read-only", value: { name: "read-only" } }
        ]
      })
    });

    await host.setupAll({});
    expect(host.getCapability("tool", "read_file")).toBeTruthy();
    expect(host.getCapability("skill", "project-understanding-skill")).toBeTruthy();
    expect(host.getCapability("llmProvider", "minimax")).toBeTruthy();
    expect(host.getCapability("policy", "read-only")).toBeTruthy();

    expect(() =>
      host.register({
        manifest: {
          id: "p1",
          name: "Plugin duplicate",
          version: "0.1.0",
          description: "dup",
          capabilities: []
        },
        setup: async () => ({ capabilities: [] })
      })
    ).toThrow("duplicate plugin id");

    const duplicateCapabilityHost = new PluginHost();
    duplicateCapabilityHost.register({
      manifest: {
        id: "p2",
        name: "Plugin 2",
        version: "0.1.0",
        description: "dup capability",
        capabilities: []
      },
      setup: async () => ({
        capabilities: [
          { type: "tool", name: "read_file", value: {} },
          { type: "tool", name: "read_file", value: {} }
        ]
      })
    });
    await expect(duplicateCapabilityHost.setupAll({})).rejects.toThrow("duplicate capability");
  });
});
