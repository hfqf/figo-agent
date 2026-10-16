import messages from "../../locales/zh-CN.json";

export const copy = messages.workbench;
export const inspectorCopy = messages.traceInspector;

export function formatCopy(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) => String(values[key] ?? match));
}
