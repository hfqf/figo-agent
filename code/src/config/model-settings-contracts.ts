import type { ModelFamily } from "./model-services.js";

export interface ModelSetting {
  id: string;
  family: ModelFamily;
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  contextWindow?: number;
  maxTokens?: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  metadataSource?: string;
}
export interface VersionedModelSettings { activeModelId: string; models: ModelSetting[]; version: string }
export interface ModelSettingInput extends Omit<ModelSetting, "hasApiKey"> { apiKey?: string; clearApiKey?: boolean }
export interface ModelSettingsInput { version: string; activeModelId: string; models: ModelSettingInput[] }
