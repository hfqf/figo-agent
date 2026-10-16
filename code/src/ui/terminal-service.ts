import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { UiEventStore } from "./ui-event-store.js";
import { defaultTerminalConfig, type RuntimeTerminalConfig } from "../config/runtime-behavior.js";
import { terminateProcessTree } from "../utils/child-process.js";

export interface TerminalEntry {
  id: string;
  command: string;
  cwd: string;
  output: string;
  status: "running" | "completed" | "failed" | "stopped";
  exitCode: number | null;
  truncated: boolean;
}

export class TerminalService {
  private cwd: string;
  private entries: TerminalEntry[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(workspaceRoot: string, private readonly events: UiEventStore, private readonly sessionId: string,
    private readonly config: RuntimeTerminalConfig = defaultTerminalConfig) {
    this.cwd = workspaceRoot;
  }

  snapshot(): { cwd: string; entries: TerminalEntry[] } {
    return { cwd: this.cwd, entries: this.entries.map((entry) => ({ ...entry })) };
  }

  isRunning(): boolean { return this.child !== null; }

  async execute(command: string): Promise<TerminalEntry> {
    if (!command.trim() || command.length > this.config.maxCommandChars || command.includes("\0")) throw new Error("终端命令无效。");
    if (this.child) throw new Error("已有终端命令正在运行。");
    const entry: TerminalEntry = {
      id: randomUUID(), command, cwd: this.cwd, output: "", status: "running", exitCode: null, truncated: false
    };
    this.entries = [...this.entries, entry].slice(-this.config.historyEntries);
    const commandHash = createHash("sha256").update(command).digest("hex");
    this.events.append({ sessionId: this.sessionId, kind: "terminal.started", subjectId: entry.id, payload: { commandHash, cwd: this.cwd } });

    const cd = /^cd(?:\s+(.*))?$/.exec(command.trim());
    if (cd) {
      try {
        const target = cd[1]?.trim().replace(/^(?:"(.*)"|'(.*)')$/, "$1$2") || process.env.HOME || this.cwd;
        const expanded = target === "~" ? process.env.HOME || this.cwd :
          target.startsWith("~/") ? resolve(process.env.HOME || this.cwd, target.slice(2)) : target;
        const path = await realpath(resolve(this.cwd, expanded));
        if (!(await stat(path)).isDirectory()) throw new Error("不是目录。");
        this.cwd = path;
        entry.output = path + "\n";
        entry.status = "completed";
        entry.exitCode = 0;
      } catch (error) {
        entry.output = (error instanceof Error ? error.message : "目录切换失败。") + "\n";
        entry.status = "failed";
        entry.exitCode = 1;
      }
      this.finish(entry);
      return { ...entry };
    }

    try {
      const options = { cwd: this.cwd, detached: process.platform !== "win32", env: process.env, windowsHide: true };
      const child = process.platform === "win32"
        ? spawn(command, { ...options, shell: true })
        : spawn(process.env.SHELL || "/bin/sh", ["-lc", command], options);
      this.child = child;
      this.stopped = false;
      const append = (data: Buffer) => {
        const remaining = this.config.maxOutputBytes - Buffer.byteLength(entry.output);
        if (remaining <= 0) { entry.truncated = true; return; }
        entry.output += data.subarray(0, remaining).toString("utf8");
        if (data.length > remaining) entry.truncated = true;
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => { append(Buffer.from(error.message)); });
      child.on("close", (code) => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.child = null;
        entry.exitCode = code;
        entry.status = this.stopped ? "stopped" : code === 0 ? "completed" : "failed";
        this.finish(entry);
      });
      this.timer = setTimeout(() => this.stop(), this.config.timeoutMs);
    } catch (error) {
      entry.output = error instanceof Error ? error.message : "命令启动失败。";
      entry.status = "failed";
      this.finish(entry);
    }
    return { ...entry };
  }

  stop(): void {
    if (!this.child || this.stopped) return;
    this.stopped = true;
    try {
      terminateProcessTree(this.child);
    } catch { /* 进程已经结束。 */ }
  }

  close(): void { this.stop(); }

  private finish(entry: TerminalEntry): void {
    this.events.append({
      sessionId: this.sessionId, kind: `terminal.${entry.status}`, subjectId: entry.id,
      payload: { commandHash: createHash("sha256").update(entry.command).digest("hex"), cwd: entry.cwd, exitCode: entry.exitCode, truncated: entry.truncated }
    });
  }
}
