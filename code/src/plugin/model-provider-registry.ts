import type { RuntimeLlmConfig } from "../config/runtime-config.js";
import type { LLMProvider } from "../contracts/types.js";

export interface ModelProviderRegistry {
  get(id: string): LLMProvider | undefined;
  prepare(models: readonly RuntimeLlmConfig[]): () => void;
}

/** 静态插件内的连接配置注册表；不加载、卸载或重新初始化插件。 */
export class ConfiguredModelProviders implements ModelProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  constructor(private readonly createProvider: (config: RuntimeLlmConfig) => LLMProvider, models: readonly RuntimeLlmConfig[]) {
    this.prepare(models)();
  }

  get(id: string): LLMProvider | undefined { return this.providers.get(id); }

  prepare(models: readonly RuntimeLlmConfig[]): () => void {
    const next = new Map<string, LLMProvider>();
    for (const model of models) {
      if (model.enabled) next.set(model.id, this.createProvider({ ...model }));
    }
    // 全部连接准备好后再同步替换；已取得的 Provider 引用不被就地修改。
    return () => { this.providers = next; };
  }
}
