import { randomUUID } from "node:crypto";
import type { ParentPort } from "electron";
import type { MainToService, ServiceToMain } from "./protocol.js";
import { verifySqliteRuntime } from "./runtime-check.js";
import { startWorkbench, type WorkbenchHandle } from "../ui/start-workbench.js";

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error("桌面服务必须由 Electron 启动。");

let workbench: WorkbenchHandle | undefined;
const picks = new Map<string, (path: string | null) => void>();
function send(message: ServiceToMain): void { parentPort.postMessage(message); }

async function handle(message: MainToService): Promise<void> {
  switch (message.type) {
    case "start": {
      if (workbench) throw new Error("桌面服务已启动。");
      const runtime = await verifySqliteRuntime();
      const pickWorkspace = () => new Promise<string | null>((resolve) => {
        const id = randomUUID();
        picks.set(id, resolve);
        send({ type: "pick-request", id });
      });
      workbench = await startWorkbench({ ...message.options, port: 0, requireAccessCode: true, requireModelKey: true, pickWorkspace });
      send({ type: "ready", url: workbench.url, accessCode: workbench.accessCode, node: runtime.node, sqlite: runtime.sqlite });
      break;
    }
    case "pick-result": {
      const resolve = picks.get(message.id);
      if (resolve) { picks.delete(message.id); resolve(message.path); }
      break;
    }
    case "status": {
      send({ type: "status", busy: workbench?.hasActiveWork() ?? false });
      break;
    }
    case "stop": {
      for (const resolve of picks.values()) resolve(null);
      picks.clear();
      await workbench?.close();
      send({ type: "stopped" });
      setTimeout(() => process.exit(0), 10);
      break;
    }
  }
}

parentPort.on("message", (event) => {
  void handle(event.data as MainToService).catch(() => {
    send({ type: "failed", message: "桌面服务启动或运行失败。" });
    setTimeout(() => process.exit(1), 10);
  });
});
