import { ContextBuilder } from "../context/context-builder.js";
import { LLMHttpCaptureStore } from "../llm/llm-http-capture-store.js";
import { OpenAICompatibleProvider } from "../llm/openai-compatible-provider.js";
import { SqliteMemoryStore } from "../memory/sqlite-memory-store.js";
import { PluginHost } from "../plugin/plugin-host.js";
import { ControlledToolPolicy } from "../policy/controlled-tool-policy.js";
import { MarkdownReporter } from "../reporter/markdown-reporter.js";
import { ProjectUnderstandingSkill } from "../skill/project-understanding-skill.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { createBrowserTools } from "../tools/browser-tools.js";
import { createCommandTools } from "../tools/command-tools.js";
import { createGitTools } from "../tools/git-tools.js";
import { createNetworkTools } from "../tools/network-tools.js";
import { createReadOnlyTools } from "../tools/read-only-tools.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { createWriteTools } from "../tools/write-tools.js";
import type { TraceRecorder } from "../trace/trace-recorder.js";

export function createBuiltinPluginHost(
  storage: StorageManager,
  trace?: TraceRecorder,
  sessionId?: string,
  config: RuntimeConfig = defaultRuntimeConfig
): PluginHost {
  const host = new PluginHost(trace, sessionId);
  host.register({
    manifest: {
      id: "builtin",
      name: "Builtin V1 Capabilities",
      version: "0.1.0",
      description: "V1 静态内置插件",
      capabilities: []
    },
    setup: async () => {
      const policy = new ControlledToolPolicy(storage.paths.workspaceRoot, config.tools.allowed);
      const toolRegistry = new ToolRegistry(policy, trace);
      for (const tool of [
        ...createReadOnlyTools(),
        ...createWriteTools(),
        ...createCommandTools(),
        ...createGitTools(),
        ...createNetworkTools(),
        ...createBrowserTools()
      ]) {
        if (config.tools.allowed.includes(tool.name)) toolRegistry.register(tool);
      }
      const memoryStore = new SqliteMemoryStore(storage);

      return {
        capabilities: [
          { type: "policy", name: "controlled-tool-policy", value: policy },
          { type: "tool", name: "registry", value: toolRegistry },
          { type: "memoryStore", name: "sqlite", value: memoryStore },
          {
            type: "contextSource",
            name: "context-builder",
            value: new ContextBuilder(storage, memoryStore, trace, config.context)
          },
          {
            type: "llmProvider",
            name: "minimax",
            value: new OpenAICompatibleProvider({
              config: config.llm,
              captureStore: new LLMHttpCaptureStore(storage)
            })
          },
          {
            type: "skill",
            name: "project-understanding-skill",
            value: new ProjectUnderstandingSkill(storage, toolRegistry)
          },
          { type: "reporter", name: "markdown", value: new MarkdownReporter(storage) }
        ]
      };
    }
  });
  return host;
}
import type { RuntimeConfig } from "../config/runtime-config.js";
import { defaultRuntimeConfig } from "../config/runtime-config.js";
