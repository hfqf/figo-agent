import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authenticateDesktop } from "../../src/desktop/auth.js";
import { startWorkbench } from "../../src/ui/start-workbench.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("desktop local authentication", () => {
  it("exchanges the private access code for a session cookie", async () => {
    root = await mkdtemp(join(tmpdir(), "figo-desktop-auth-"));
    const configRoot = join(root, "config");
    const workspaceRoot = join(root, "project");
    await mkdir(configRoot); await mkdir(workspaceRoot);
    await writeFile(join(root, "index.html"), "<title>desktop</title>");
    const workbench = await startWorkbench({ configRoot, workspaceRoot, staticRoot: root, port: 0, requireAccessCode: true });
    try {
      expect((await fetch(`${workbench.url}/api/v1/bootstrap`)).status).toBe(401);
      const cookie = await authenticateDesktop(workbench.url, workbench.accessCode);
      expect(cookie.name).toBe("figo_sid");
      const response = await fetch(`${workbench.url}/api/v1/bootstrap`, { headers: { cookie: `${cookie.name}=${cookie.value}` } });
      expect(response.status).toBe(200);
    } finally { await workbench.close(); }
  });
});
