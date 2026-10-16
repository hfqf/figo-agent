import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultTerminalConfig } from "../../src/config/runtime-behavior.js";
import { TerminalService } from "../../src/ui/terminal-service.js";
import { UiEventStore } from "../../src/ui/ui-event-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TestDatabases } from "../helpers/test-databases.js";

let workspace = "";
let terminal: TerminalService | undefined;
const databases = new TestDatabases();
afterEach(async () => {
  terminal?.close();
  if (terminal) await vi.waitFor(() => expect(terminal!.isRunning()).toBe(false), { timeout: 7000 });
  terminal = undefined;
  databases.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

async function fixture(timeoutMs = 10000) {
  workspace = await mkdtemp(join(tmpdir(), "figo-terminal-platform-"));
  const storage = databases.track(await StorageManager.init(workspace));
  const events = new UiEventStore(storage);
  terminal = new TerminalService(workspace, events, "test", { ...defaultTerminalConfig, timeoutMs });
  return { terminal, events };
}

describe("TerminalService 跨平台执行", () => {
  it("通过本机 shell 执行命令并保留工作目录和审计摘要", async () => {
    const { terminal, events } = await fixture();
    const command = 'node -e "console.log(process.cwd())"';
    await terminal.execute(command);
    await vi.waitFor(() => expect(terminal.isRunning()).toBe(false), { timeout: 2000 });
    expect(terminal.snapshot().entries.at(-1)).toMatchObject({ status: "completed", exitCode: 0 });
    expect(terminal.snapshot().entries.at(-1)?.output.trim()).toBe(await realpath(workspace));
    expect(events.replay(0).map((event) => event.kind)).toEqual(["terminal.started", "terminal.completed"]);
    expect(JSON.stringify(events.replay(0))).not.toContain(command);
  });

  it("子进程启动后停止整棵进程树，并允许后续命令执行", async () => {
    const { terminal, events } = await fixture();
    await terminal.execute('node -e "require(\'fs\').writeFileSync(\'started\', String(process.pid)); setTimeout(() => console.log(\'late\'), 5000)"');
    let childPid = 0;
    await vi.waitFor(async () => {
      const pid = await readFile(join(workspace, "started"), "utf8");
      expect(pid).toMatch(/^\d+$/);
      childPid = Number(pid);
    }, { timeout: 2000 });
    const stoppedAt = Date.now();
    terminal.stop();
    terminal.stop();
    await vi.waitFor(() => expect(terminal.isRunning()).toBe(false), { timeout: 2000 });
    expect(Date.now() - stoppedAt).toBeLessThan(2000);
    expect(terminal.snapshot().entries.at(-1)).toMatchObject({ status: "stopped", output: "" });
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(events.replay(0).filter((event) => event.kind === "terminal.stopped")).toHaveLength(1);
    await terminal.execute('node -e "console.log(\'next\')"');
    await vi.waitFor(() => expect(terminal.isRunning()).toBe(false), { timeout: 2000 });
    expect(terminal.snapshot().entries.at(-1)).toMatchObject({ status: "completed", exitCode: 0, output: "next\n" });
  });

  it("终端超时也结束子进程并记录停止事件", async () => {
    const { terminal, events } = await fixture(1000);
    await terminal.execute('node -e "console.log(\'started\'); setTimeout(() => console.log(\'late\'), 5000)"');
    await vi.waitFor(() => expect(terminal.isRunning()).toBe(false), { timeout: 3000 });
    expect(terminal.snapshot().entries.at(-1)).toMatchObject({ status: "stopped", output: "started\n" });
    expect(events.replay(0).at(-1)?.kind).toBe("terminal.stopped");
  });
});

describe("TerminalService configuration", () => {
  it("keeps only the configured number of history entries", async () => {
    const events = { append: vi.fn() } as unknown as UiEventStore;
    const terminal = new TerminalService(process.cwd(), events, "session-test", {
      ...defaultTerminalConfig, historyEntries: 1, maxCommandChars: 8
    });
    await terminal.execute("cd .");
    await terminal.execute("cd ..");
    expect(terminal.snapshot().entries.map((entry) => entry.command)).toEqual(["cd .."]);
    await expect(terminal.execute("123456789")).rejects.toThrow("终端命令无效");
  });
});
