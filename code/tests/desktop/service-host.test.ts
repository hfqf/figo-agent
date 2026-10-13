import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { utilityProcess } from "electron";
import { DesktopServiceHost } from "../../src/desktop/service-host.js";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

function childProcess() {
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
  vi.mocked(utilityProcess.fork).mockReturnValue(child as never);
  return child;
}

async function start(child: ReturnType<typeof childProcess>, onUnexpectedExit = vi.fn()) {
  const starting = DesktopServiceHost.start("service.js", {
    configRoot: "/config", workspaceRoot: "/workspace", staticRoot: "/static"
  }, async () => null, onUnexpectedExit);
  child.emit("message", { type: "ready", url: "http://127.0.0.1:1234", accessCode: "test", node: "24", sqlite: "3" });
  return { ...(await starting), onUnexpectedExit };
}

beforeEach(() => vi.clearAllMocks());

describe("DesktopServiceHost", () => {
  it("reports a service failure only once when the process then exits", async () => {
    const child = childProcess();
    const { onUnexpectedExit } = await start(child);
    child.emit("message", { type: "failed", message: "failed" });
    child.emit("exit", 1);
    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it("waits for process exit after a forced stop", async () => {
    const child = childProcess();
    const { host, onUnexpectedExit } = await start(child);
    let settled = false;
    const stopping = host.stop(true).then(() => { settled = true; });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    child.emit("exit", 0);
    await stopping;
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it("kills a service that does not become ready within the startup deadline", async () => {
    vi.useFakeTimers();
    try {
      const child = childProcess();
      const starting = DesktopServiceHost.start("service.js", {
        configRoot: "/config", workspaceRoot: "/workspace", staticRoot: "/static"
      }, async () => null, vi.fn());
      const rejected = expect(starting).rejects.toThrow("桌面服务启动超时");
      await vi.advanceTimersByTimeAsync(20000);
      await rejected;
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
