import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_LAYOUT, decodeWorkspaceLayout, fitWorkspaceLayout, resizeWorkspaceLayout } from "../../web/src/workspace-layout.js";

describe("workspace layout", () => {
  it("keeps editor, tree and task panel within desktop reading bounds", () => {
    expect(fitWorkspaceLayout({ tree: 500, task: 700, inspector: 700 }, 1000)).toEqual({ tree: 120, task: 560, inspector: 320 });
    expect(fitWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, 1440)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("resizes each boundary independently and clamps before editor collapses", () => {
    const base = DEFAULT_WORKSPACE_LAYOUT;
    expect(resizeWorkspaceLayout(base, "tree", 60, 1440).tree).toBe(base.tree + 60);
    expect(resizeWorkspaceLayout(base, "task", -80, 1440).task).toBe(base.task + 80);
    expect(resizeWorkspaceLayout(base, "inspector", -50, 1440).inspector).toBe(base.inspector + 50);
    expect(resizeWorkspaceLayout(base, "tree", 2000, 1000).tree).toBe(260);
    expect(resizeWorkspaceLayout(base, "task", -2000, 1000).task).toBe(475);
  });

  it("ignores malformed persisted values", () => {
    expect(decodeWorkspaceLayout("not json", 1440)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(decodeWorkspaceLayout('{"tree":-10,"task":"wide","inspector":null}', 1440)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });
});
