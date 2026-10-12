import { describe, expect, it, vi } from "vitest";
import { defaultTerminalConfig } from "../../src/config/runtime-behavior.js";
import { TerminalService } from "../../src/ui/terminal-service.js";
import type { UiEventStore } from "../../src/ui/ui-event-store.js";

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
