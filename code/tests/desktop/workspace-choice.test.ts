import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseDesktopWorkspace } from "../../src/desktop/workspace-choice.js";
import { WorkspaceRegistry } from "../../src/ui/workspace-registry.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("chooseDesktopWorkspace", () => {
  it("returns no workspace on first run without opening a picker", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-choice-"));
    expect(await chooseDesktopWorkspace(root)).toBeNull();
  });

  it("uses a valid recent workspace without opening the picker", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-choice-"));
    const workspace = join(root, "project");
    await mkdir(workspace);
    const registry = await WorkspaceRegistry.open(root);
    registry.record(workspace); registry.close();
    expect(await chooseDesktopWorkspace(root)).toBe(await realpath(workspace));
  });

  it("skips a missing recent workspace and stays in setup", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-choice-"));
    const removed = join(root, "removed");
    const registry = await WorkspaceRegistry.open(root);
    registry.record(removed); registry.close();
    expect(await chooseDesktopWorkspace(root)).toBeNull();
  });
});
