import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlledToolPolicy } from "../../src/policy/controlled-tool-policy.js";
import { createBrowserTools } from "../../src/tools/browser-tools.js";
import { createNetworkTools } from "../../src/tools/network-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

let workspace = "";
let server: Server;
let baseUrl = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
  server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><head><title>Figo Tool</title></head><body><main>hello browser</main></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "object" && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("network and browser tools", () => {
  it("fetches network responses with bounded text output", async () => {
    const registry = registryWithTools();

    const result = await registry.execute("network_fetch", { url: baseUrl, maxBytes: 2000 }, toolContext());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output.status).toBe(200);
      expect(result.output.body).toContain("hello browser");
    }
  });

  it("opens a URL and returns the latest browser snapshot", async () => {
    const registry = registryWithTools();

    const opened = await registry.execute("browser_open", { url: baseUrl }, toolContext());
    expect(opened.status).toBe("completed");
    if (opened.status === "completed") {
      expect(opened.output.title).toBe("Figo Tool");
    }

    const snapshot = await registry.execute("browser_snapshot", {}, toolContext());
    expect(snapshot.status).toBe("completed");
    if (snapshot.status === "completed") {
      expect(snapshot.output.text).toContain("hello browser");
    }
  });
});

function registryWithTools(): ToolRegistry {
  const registry = new ToolRegistry(new ControlledToolPolicy(workspace));
  for (const tool of createNetworkTools()) registry.register(tool);
  for (const tool of createBrowserTools()) registry.register(tool);
  return registry;
}

function toolContext() {
  return {
    sessionId: "ses_1",
    taskId: "task_1",
    turnId: "turn_1",
    workspaceRoot: workspace
  };
}
