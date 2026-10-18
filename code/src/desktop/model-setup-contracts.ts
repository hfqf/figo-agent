import type { ModelFamily } from "../config/model-services.js";
import type { VersionedModelSettings } from "../config/model-settings-contracts.js";

export interface DesktopModelSetup {
  id: string;
  baseUrl: string;
  model: string;
  configured: boolean;
  family: ModelFamily;
  settings: VersionedModelSettings;
}
export interface DesktopModelDiscoveryInput { family: ModelFamily; baseUrl: string; apiKey: string }
export interface DesktopModelInput extends DesktopModelDiscoveryInput { version: string; model: string }
