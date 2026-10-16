import type { TraceRecorder } from "../trace/trace-recorder.js";
import type { ModelProviderRegistry } from "./model-provider-registry.js";

export type CapabilityType =
  | "llmProvider"
  | "llmProviderRegistry"
  | "contextSource"
  | "memoryStore"
  | "skill"
  | "tool"
  | "reporter"
  | "policy";

export interface CapabilityDeclaration {
  type: CapabilityType;
  name: string;
  description: string;
}

export interface Capability<T = unknown> {
  type: CapabilityType;
  name: string;
  value: T;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: CapabilityDeclaration[];
}

export interface Plugin {
  manifest: PluginManifest;
  setup(context: unknown): Promise<{ capabilities: Capability[] }>;
}

export class PluginHost {
  private readonly plugins = new Map<string, Plugin>();
  private readonly capabilities = new Map<string, Capability>();

  constructor(
    private readonly trace?: TraceRecorder,
    private readonly sessionId?: string
  ) {}

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`duplicate plugin id: ${plugin.manifest.id}`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  async setupAll(context: unknown): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await this.record("plugin.registered", {
        pluginId: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version
      });
      const result = await plugin.setup(context);
      for (const capability of result.capabilities) {
        const key = capabilityKey(capability.type, capability.name);
        if (this.capabilities.has(key)) {
          throw new Error(`duplicate capability: ${key}`);
        }
        this.capabilities.set(key, capability);
        await this.record("capability.registered", {
          pluginId: plugin.manifest.id,
          type: capability.type,
          name: capability.name
        });
      }
      await this.record("plugin.ready", {
        pluginId: plugin.manifest.id,
        capabilityCount: result.capabilities.length
      });
    }
  }

  getCapability<T = unknown>(type: CapabilityType, name: string): T | undefined {
    const capability = this.capabilities.get(capabilityKey(type, name));
    if (capability) return capability.value as T;
    if (type === "llmProvider") {
      return this.getCapability<ModelProviderRegistry>("llmProviderRegistry", "models")?.get(name) as T | undefined;
    }
    return undefined;
  }

  requireCapability<T = unknown>(type: CapabilityType, name: string): T {
    const capability = this.getCapability<T>(type, name);
    if (!capability) {
      throw new Error(`missing capability: ${capabilityKey(type, name)}`);
    }
    return capability;
  }

  private async record(
    type: "plugin.registered" | "plugin.ready" | "capability.registered",
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.trace || !this.sessionId) return;
    await this.trace.record({
      sessionId: this.sessionId,
      type,
      source: "PluginHost",
      payload
    });
  }
}

function capabilityKey(type: CapabilityType, name: string): string {
  return `${type}:${name}`;
}
