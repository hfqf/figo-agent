import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/** shell 的子进程可能继续持有输出管道，停止时必须覆盖整棵进程树。 */
export function terminateProcessTree(child: ChildProcess): void {
  if (child.pid && process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore"
    });
    killer.on("error", () => child.kill("SIGTERM"));
    killer.on("exit", (code) => { if (code !== 0) child.kill("SIGTERM"); });
    return;
  }
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); return; }
    catch { /* 进程组已结束时，尝试释放仍存活的直接子进程。 */ }
  }
  child.kill("SIGTERM");
}
