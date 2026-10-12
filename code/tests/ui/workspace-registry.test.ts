import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceRegistry, resolveWorkspace } from "../../src/ui/workspace-registry.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

it("stores recent absolute workspaces in SQLite and restores them", async () => {
  root = await mkdtemp(join(tmpdir(), "figo-workspaces-"));
  const registry = await WorkspaceRegistry.open(root);
  registry.record(await resolveWorkspace(root));
  registry.record("/tmp/another-project");
  registry.record(await resolveWorkspace(root));
  registry.close();
  const reopened = await WorkspaceRegistry.open(root);
  expect(reopened.recent()).toEqual([await realpath(root), "/tmp/another-project"]);
  reopened.close();
});

it("rejects relative, missing and file paths", async () => {
  root = await mkdtemp(join(tmpdir(), "figo-workspaces-"));
  await writeFile(join(root, "file.txt"), "x");
  await expect(resolveWorkspace("./project")).rejects.toThrow("绝对目录");
  await expect(resolveWorkspace(join(root, "missing"))).rejects.toThrow("不存在");
  await expect(resolveWorkspace(join(root, "file.txt"))).rejects.toThrow("不是目录");
});
