import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startWorkbench } from "../../src/ui/start-workbench.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("startWorkbench", () => {
  it("rejects a missing static build before opening the workspace database", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-no-assets-"));
    const configRoot = join(root, "settings");
    const workspaceRoot = join(root, "project");
    await mkdir(configRoot); await mkdir(workspaceRoot);
    await expect(startWorkbench({ configRoot, workspaceRoot, staticRoot: join(root, "missing"), port: 0, requireAccessCode: true }))
      .rejects.toThrow("工作台静态资源不存在");
  });

  it("uses explicit roots and dynamic port without depending on cwd", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-start-"));
    const configRoot = join(root, "settings");
    const workspaceRoot = join(root, "project");
    const staticRoot = join(root, "static");
    await mkdir(configRoot); await mkdir(workspaceRoot); await mkdir(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<title>desktop</title>");
    const workbench = await startWorkbench({ configRoot, workspaceRoot, staticRoot, port: 0, requireAccessCode: true });
    try {
      expect(workbench.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(workbench.url)).status).toBe(200);
      expect((await fetch(`${workbench.url}/api/v1/bootstrap`)).status).toBe(401);
      expect(workbench.kernel.storage.paths.workspaceRoot).toBe(await realpath(workspaceRoot));
    } finally {
      await workbench.close();
    }
  });

  it("lets a desktop picker replace the platform-specific folder command", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-picker-"));
    const configRoot = join(root, "settings");
    const workspaceRoot = join(root, "project");
    const chosen = join(root, "chosen");
    await mkdir(configRoot); await mkdir(workspaceRoot); await mkdir(chosen);
    await writeFile(join(root, "index.html"), "<title>desktop</title>");
    const workbench = await startWorkbench({ configRoot, workspaceRoot, staticRoot: root, port: 0, requireAccessCode: false, pickWorkspace: async () => chosen });
    try {
      const bootstrap = await (await fetch(`${workbench.url}/api/v1/bootstrap`)).json() as { csrf: string };
      const selected = await fetch(`${workbench.url}/api/v1/workspaces/pick`, {
        method: "POST", headers: { origin: workbench.url, "x-figo-csrf": bootstrap.csrf }
      });
      expect(selected.status).toBe(200);
      expect(await selected.json()).toEqual({ path: await realpath(chosen) });
    } finally {
      await workbench.close();
    }
  });

  it("rejects desktop turns when the active model has no API key", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-model-key-"));
    const configRoot = join(root, "settings");
    const workspaceRoot = join(root, "project");
    await mkdir(configRoot); await mkdir(workspaceRoot);
    await writeFile(join(root, "index.html"), "<title>desktop</title>");
    const workbench = await startWorkbench({
      configRoot, workspaceRoot, staticRoot: root, port: 0, requireAccessCode: false, requireModelKey: true
    });
    try {
      const bootstrap = await (await fetch(`${workbench.url}/api/v1/bootstrap`)).json() as { modelConfigured: boolean; csrf: string };
      expect(bootstrap.modelConfigured).toBe(false);
      const taskResponse = await fetch(`${workbench.url}/api/v1/tasks`, {
        method: "POST", headers: { origin: workbench.url, "x-figo-csrf": bootstrap.csrf, "content-type": "application/json" },
        body: JSON.stringify({ title: "测试任务" })
      });
      expect(taskResponse.status).toBe(201);
      const task = await taskResponse.json() as { id: string };
      const turnResponse = await fetch(`${workbench.url}/api/v1/tasks/${task.id}/turns`, {
        method: "POST", headers: { origin: workbench.url, "x-figo-csrf": bootstrap.csrf, "content-type": "application/json" },
        body: JSON.stringify({ input: "你好", clientRequestId: "desktop-test-1" })
      });
      expect(turnResponse.status).toBe(409);
      expect((await turnResponse.json() as { error: string }).error).toContain("API Key");
      expect(workbench.kernel.storage.db.prepare("select count(*) as count from turns").get()).toMatchObject({ count: 0 });
    } finally {
      await workbench.close();
    }
  });
});
