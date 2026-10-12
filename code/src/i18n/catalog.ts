import { readFileSync } from "node:fs";

export interface LocaleCatalog {
  agent: {
    systemTemplate: string;
    taskCompactionTemplate: string;
    roundCompactionTemplate: string;
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
  return template.replace(/\{(systemInstruction|maxToolRounds|availableTools|maxSummaryChars)\}/g,
    (whole, key: string) => key in values ? String(values[key]) : whole);
}
