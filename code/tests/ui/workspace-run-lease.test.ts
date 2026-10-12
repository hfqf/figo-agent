import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { WorkspaceRunLease } from "../../src/ui/workspace-run-lease.js";

let workspace = "";
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

it("allows exactly one active workspace execution lease", async () => {
  workspace = await mkdtemp(join(tmpdir(), "figo-ui-lease-"));
  const storage = await StorageManager.init(workspace);
  const secondStorage = await StorageManager.init(workspace);
  const first = new WorkspaceRunLease(storage);
  const second = new WorkspaceRunLease(secondStorage);
  const release = first.acquire("run-a");
  expect(() => second.acquire("run-b")).toThrow("工作区已有执行中的 Agent");
  release();
  const releaseSecond = second.acquire("run-b");
  releaseSecond();
});
