import { utilityProcess, type UtilityProcess } from "electron";
import type { DesktopStartOptions, MainToService, ServiceToMain } from "./protocol.js";

export interface ServiceReady {
  url: string;
  accessCode: string;
  node: string;
  sqlite: string;
}

export class DesktopServiceHost {
  private stopped = false;
  private pendingStatus: ((busy: boolean) => void) | undefined;

  private constructor(
    private readonly child: UtilityProcess,
    private readonly pickWorkspace: () => Promise<string | null>,
    private readonly onUnexpectedExit: () => void
  ) {}

  static async start(
    entry: string, options: DesktopStartOptions,
    pickWorkspace: () => Promise<string | null>, onUnexpectedExit: () => void
  ): Promise<{ host: DesktopServiceHost; ready: ServiceReady }> {
    const child = utilityProcess.fork(entry);
    const host = new DesktopServiceHost(child, pickWorkspace, onUnexpectedExit);
    const ready = await new Promise<ServiceReady>((resolve, reject) => {
      let started = false;
      const timeout = setTimeout(() => { child.kill(); reject(new Error("桌面服务启动超时。")); }, 20000);
      child.on("message", (message: ServiceToMain) => {
        if (message.type === "ready") {
          started = true;
          clearTimeout(timeout);
          resolve({ url: message.url, accessCode: message.accessCode, node: message.node, sqlite: message.sqlite });
        } else if (message.type === "failed") {
          clearTimeout(timeout);
          if (!started) reject(new Error(message.message));
        } else if (message.type === "pick-request") {
          void pickWorkspace().then((path) => child.postMessage({ type: "pick-result", id: message.id, path } satisfies MainToService))
            .catch(() => child.postMessage({ type: "pick-result", id: message.id, path: null } satisfies MainToService));
        } else if (message.type === "status") {
          host.pendingStatus?.(message.busy);
          host.pendingStatus = undefined;
        }
      });
      child.on("exit", (code) => {
        host.stopped = true;
        clearTimeout(timeout);
        host.pendingStatus?.(true);
        if (!started) reject(new Error(`桌面服务退出，状态码 ${code}。`));
        else if (!host.intentionalStop) onUnexpectedExit();
      });
      child.postMessage({ type: "start", options } satisfies MainToService);
    });
    return { host, ready };
  }

  private intentionalStop = false;

  async isBusy(): Promise<boolean> {
    if (this.stopped) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.pendingStatus = undefined; resolve(true); }, 3000);
      this.pendingStatus = (busy) => { clearTimeout(timer); resolve(busy); };
      this.child.postMessage({ type: "status" } satisfies MainToService);
    });
  }

  async stop(force = false): Promise<void> {
    if (this.stopped) return;
    this.intentionalStop = true;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(exitTimeout);
        if (gracefulTimeout) clearTimeout(gracefulTimeout);
        this.child.removeListener("exit", finish);
        resolve();
      };
      const exitTimeout = setTimeout(finish, force ? 2000 : 12000);
      const gracefulTimeout = force ? undefined : setTimeout(() => this.child.kill(), 10000);
      this.child.once("exit", finish);
      if (force) this.child.kill();
      else this.child.postMessage({ type: "stop" } satisfies MainToService);
    });
  }
}
