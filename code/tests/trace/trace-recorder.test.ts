import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceRecorder } from "../../src/trace/trace-recorder.js";

let workspace = "";

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = "";
  }
});

describe("TraceRecorder", () => {
  it("writes trace_events and parseable trace.jsonl in record order", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db
      .prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run("ses_1", workspace, "active", "2026-10-10T00:00:00.000Z");

    const recorder = new TraceRecorder(storage);
    await recorder.record({
      sessionId: "ses_1",
      type: "session.started",
      source: "AgentKernel",
      payload: { cwd: workspace, apiKey: "secret-value" }
    });
    await recorder.record({
      sessionId: "ses_1",
      turnId: "turn_1",
      type: "turn.received",
      source: "AgentKernel",
      payload: { token: "abc" }
    });

    const rows = storage.db
      .prepare("select type, payload_json from trace_events where session_id = ? order by created_at")
      .all("ses_1") as Array<{ type: string; payload_json: string }>;
    expect(rows.map((row) => row.type)).toEqual(["session.started", "turn.received"]);
    expect(JSON.parse(rows[0].payload_json).apiKey).toBe("[REDACTED]");
    expect(JSON.parse(rows[1].payload_json).token).toBe("[REDACTED]");

    const jsonl = await readFile(
      join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"),
      "utf8"
    );
    const events = jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    expect(events.map((event) => event.type)).toEqual(["session.started", "turn.received"]);
    expect(events[0].payload.apiKey).toBe("[REDACTED]");
  });

  it("requires sessionId, type, and source", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    const recorder = new TraceRecorder(storage);

    await expect(
      recorder.record({
        sessionId: "",
        type: "error.occurred",
        source: "TraceRecorder"
      })
    ).rejects.toThrow("sessionId is required");
  });
});
