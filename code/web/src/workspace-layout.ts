export interface WorkspaceLayout {
  tree: number;
  task: number;
  inspector: number;
}

export type WorkspaceBoundary = keyof WorkspaceLayout;

export const WORKSPACE_LAYOUT_KEY = "figo-workbench-layout-v1";
export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = { tree: 205, task: 420, inspector: 400 };

const MIN_TREE = 120;
const MIN_TASK = 320;
const MIN_EDITOR = 320;
const MIN_INSPECTOR = 300;

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

export function workspaceBoundaryLimits(layout: WorkspaceLayout, boundary: WorkspaceBoundary, width: number): [number, number] {
  if (boundary === "tree") return [MIN_TREE, Math.max(MIN_TREE, Math.min(380, width - layout.task - MIN_EDITOR))];
  if (boundary === "task") return [MIN_TASK, Math.max(MIN_TASK, Math.min(620, width - layout.tree - MIN_EDITOR))];
  return [MIN_INSPECTOR, Math.max(MIN_INSPECTOR, Math.min(600, width - layout.task - layout.tree))];
}

export function fitWorkspaceLayout(layout: WorkspaceLayout, width: number): WorkspaceLayout {
  const usable = Math.max(width, MIN_TREE + MIN_TASK + MIN_EDITOR);
  const task = clamp(layout.task, MIN_TASK, Math.min(620, usable - MIN_TREE - MIN_EDITOR));
  const tree = clamp(layout.tree, MIN_TREE, Math.min(380, usable - task - MIN_EDITOR));
  const inspector = clamp(layout.inspector, MIN_INSPECTOR, Math.min(600, usable - task - tree));
  return { tree, task, inspector };
}

export function resizeWorkspaceLayout(layout: WorkspaceLayout, boundary: WorkspaceBoundary, delta: number, width: number): WorkspaceLayout {
  const [min, max] = workspaceBoundaryLimits(layout, boundary, width);
  const next = { ...layout, [boundary]: clamp(layout[boundary] + (boundary === "tree" ? delta : -delta), min, max) };
  return fitWorkspaceLayout(next, width);
}

export function decodeWorkspaceLayout(value: string | null, width: number): WorkspaceLayout {
  try {
    const parsed = JSON.parse(value ?? "null") as Partial<WorkspaceLayout> | null;
    if (!parsed || typeof parsed !== "object" ||
        !(["tree", "task", "inspector"] as const).every((key) => typeof parsed[key] === "number" && Number.isFinite(parsed[key]) && parsed[key]! > 0)) {
      return DEFAULT_WORKSPACE_LAYOUT;
    }
    const layout = parsed as WorkspaceLayout;
    return width <= 900 ? layout : fitWorkspaceLayout(layout, width);
  } catch {
    return DEFAULT_WORKSPACE_LAYOUT;
  }
}
