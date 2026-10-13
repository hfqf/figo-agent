import { readFileSync } from "node:fs";

export interface LocaleCatalog {
  workbench: { modelKeyMissing: string };
  desktop: {
    startupFailed: string;
    chooseWorkspace: string;
    serviceExited: string;
    fileMenu: string;
    openModelConfig: string;
    importOldConfig: string;
    modelSetupTitle: string;
    modelKeyMissing: string;
    importOldConfigButton: string;
    openConfigButton: string;
    laterButton: string;
    chooseLegacyConfig: string;
    importCompleteTitle: string;
    importCompleteMessage: string;
    importFailedTitle: string;
    importFailedMessage: string;
    busyExitTitle: string;
    busyExitMessage: string;
    waitButton: string;
    forceQuitButton: string;
  };
  agent: {
    systemTemplate: string;
    nativeSystemTemplate: string;
    taskCompactionTemplate: string;
    roundCompactionTemplate: string;
    protocolRepair: string;
    nativeProtocolRepair: string;
    protocolFailed: string;
    workspaceScopeTemplate: string;
    noProgress: string;
    noProgressFailed: string;
    userInstructionLabel: string;
    userInputLabel: string;
    contextLabel: string;
    sourceLabel: string;
    summaryLabel: string;
    reasonLabel: string;
    contentLabel: string;
  };
}

export const zhCN = JSON.parse(readFileSync(new URL("../../locales/zh-CN.json", import.meta.url), "utf8")) as LocaleCatalog;

export function formatLocaleTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(systemInstruction|availableTools|maxSummaryChars|workspaceRoot)\}/g,
    (whole, key: string) => key in values ? String(values[key]) : whole);
}
