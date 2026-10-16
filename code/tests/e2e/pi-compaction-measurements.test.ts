import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measurePiCompactionBranch } from "../../e2e/pi-compaction-measurements.js";
import type { ConversationMessage } from "../../src/context/conversation-message.js";
import { CompactionStore } from "../../src/context/compaction-store.js";
import { TurnManager } from "../../src/kernel/turn-manager.js";
import { LLMHttpCaptureStore } from "../../src/llm/llm-http-capture-store.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

let root = "";
let storage: StorageManager;
afterEach(async () => {
  if (storage?.db.isOpen) storage.db.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

type PrefixMessage = Pick<ConversationMessage, "sourceRef" | "message" | "omitted" | "stopReason">;
const prefixMessages: PrefixMessage[] = [
  { sourceRef: "turn:first:user", message: { role: "user", content: "原始请求" } },
  { sourceRef: "request:first:response", message: { role: "assistant", content: "原始答复" } },
  { sourceRef: "turn:last:user", message: { role: "user", content: "原始后续请求" } }
];

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "figo-branch-measurements-"));
  storage = await StorageManager.init(root);
  storage.db.prepare("insert into sessions (id,cwd,status,started_at) values (?,?,?,?)").run("session", root, "active", "2026-10-15 12:00:00.000");
  for (const id of ["task", "other-task"]) storage.db.prepare("insert into tasks (id,session_id,title,status,created_at,updated_at) values (?,?,?,?,?,?)")
    .run(id, "session", id, "active", "2026-10-15 12:00:00.000", "2026-10-15 12:00:00.000");
  const turns = new TurnManager(storage);
  const oldTurn = turns.create("session", "task", "共同前缀");
  const target = turns.create("session", "task", "分支后续任务");
  const other = turns.create("session", "other-task", "其它任务");
  const captures = new LLMHttpCaptureStore(storage);
  const store = new CompactionStore(storage);
  let baseEntryId: string | undefined;
  function capture(requestId: string, options: {
    purpose?: "turn" | "task_compaction" | "round_compaction"; turnId?: string; taskId?: string;
    usage?: unknown; durationMs?: number; status?: number; messages?: unknown[]; requestBody?: unknown
  } = {}) {
    captures.record({ sessionId: "session", taskId: options.taskId ?? "task", turnId: options.turnId ?? target.id,
      requestId, provider: "test", model: "test", url: "https://example.test/v1/chat/completions", method: "POST",
      purpose: options.purpose ?? "turn", requestHeaders: {}, responseHeaders: {},
      requestBody: options.requestBody ?? { model: "test", messages: options.messages ?? [] },
      responseBody: { choices: [], usage: options.usage === undefined ? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } : options.usage },
      responseStatus: options.status ?? 200, responseStatusText: "test", durationMs: options.durationMs ?? 5 });
  }
  function entry(requestId: string, firstKeptSourceRef = prefixMessages[1].sourceRef, summaryMarkdown = "## Goal\n分支摘要") {
    const result = store.appendEntry({ taskId: "task", baseEntryId, firstKeptSourceRef, summaryMarkdown,
      coveredSourceRefs: [prefixMessages[0].sourceRef], details: { readFiles: [], modifiedFiles: [] }, tokensBefore: 100, requestId });
    baseEntryId = result.id;
    return result;
  }
  const measure = (prefixRequestIds: string[] = [], messages = prefixMessages) => measurePiCompactionBranch({
    storage, taskId: "task", turnId: target.id, prefixRequestIds, prefixMessages: messages
  });
  return { oldTurn, target, other, capture, entry, measure };
}

describe("measurePiCompactionBranch", () => {
  it.each([
    { omitted: true }, { stopReason: "error" as const }, { stopReason: "aborted" as const }
  ])("checks only visible retained messages when the raw suffix contains %j", async (metadata) => {
    const f = await fixture();
    const raw: PrefixMessage[] = [prefixMessages[0], { ...prefixMessages[1], ...metadata }, prefixMessages[2]];
    const original = structuredClone(raw);
    f.capture("summary", { purpose: "task_compaction" });
    f.entry("summary", raw[0].sourceRef);
    f.capture("next", { messages: [{ role: "user", content: "## Goal\n分支摘要" }, raw[0].message, raw[2].message] });
    const changes = storage.db.prepare("select total_changes() as n").get();
    storage.db.exec("PRAGMA query_only = ON");
    expect(f.measure([], raw).summaryChecks[0]).toMatchObject({ firstKeptSourceRef: raw[0].sourceRef,
      retainedPrefixMessages: 2, retainedPrefixUnchanged: true });
    expect(raw).toEqual(original);
    expect(storage.db.prepare("select total_changes() as n").get()).toEqual(changes);
  });

  it("locates an omitted boundary in the raw sequence before selecting the visible suffix", async () => {
    const f = await fixture();
    const raw: PrefixMessage[] = [prefixMessages[0], { ...prefixMessages[1], omitted: true }, prefixMessages[2]];
    f.capture("summary", { purpose: "task_compaction" });
    f.entry("summary", raw[1].sourceRef);
    f.capture("next", { messages: [{ role: "user", content: "## Goal\n分支摘要" }, raw[2].message] });
    expect(f.measure([], raw).summaryChecks[0]).toMatchObject({ firstKeptSourceRef: raw[1].sourceRef,
      retainedPrefixMessages: 1, retainedPrefixUnchanged: true });
  });

  it("does not report an entirely invisible retained suffix as verified", async () => {
    const f = await fixture();
    const raw: PrefixMessage[] = [
      { ...prefixMessages[0], omitted: true }, { ...prefixMessages[1], stopReason: "error" },
      { ...prefixMessages[2], stopReason: "aborted" }
    ];
    f.capture("summary", { purpose: "task_compaction" });
    f.entry("summary", raw[0].sourceRef);
    f.capture("next", { messages: [{ role: "user", content: "## Goal\n分支摘要" }] });
    expect(f.measure([], raw).summaryChecks[0]).toMatchObject({ firstKeptSourceRef: raw[0].sourceRef,
      summaryInNextRequest: true, retainedPrefixMessages: 0, retainedPrefixUnchanged: false });
  });

  it("does not replace an unknown raw boundary with a visible message", async () => {
    const f = await fixture();
    const raw: PrefixMessage[] = [{ ...prefixMessages[0], omitted: true }, prefixMessages[1], prefixMessages[2]];
    f.capture("summary", { purpose: "task_compaction" });
    f.entry("summary", "unknown-reference");
    f.capture("next", { messages: [{ role: "user", content: "## Goal\n分支摘要" }, ...raw.slice(1).map((entry) => entry.message)] });
    expect(f.measure([], raw).summaryChecks[0]).toMatchObject({ firstKeptSourceRef: "unknown-reference",
      summaryInNextRequest: true, retainedPrefixMessages: 0, retainedPrefixUnchanged: false });
  });

  it("excludes the copied prefix from all request costs and isolates target tools and repairs", async () => {
    const f = await fixture();
    f.capture("prefix-1", { turnId: f.oldTurn.id, durationMs: 999, usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } });
    f.capture("prefix-2", { turnId: f.oldTurn.id, durationMs: 999 });
    f.capture("summary", { purpose: "task_compaction", turnId: f.oldTurn.id, durationMs: 20,
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } });
    f.capture("new-1", { durationMs: 30, messages: [{ role: "user", content: "新请求" }] });
    f.capture("new-2", { durationMs: 40, status: 429, usage: null });
    f.capture("other", { taskId: "other-task", turnId: f.other.id, durationMs: 5000 });
    for (const [id, turnId, status] of [["old", f.oldTurn.id, "completed"], ["completed", f.target.id, "completed"],
      ["failed", f.target.id, "failed"], ["other", f.other.id, "completed"]]) {
      storage.db.prepare("insert into tool_calls (id,session_id,turn_id,tool_name,input_json,status,started_at) values (?,?,?,?,?,?,?)")
        .run(id, "session", turnId, "read_file", "{}", status, "2026-10-15 12:00:00.000");
    }
    for (const [id, taskId, turnId, type] of [["repair", "task", f.target.id, "tool_call.repair.requested"],
      ["old-repair", "task", f.oldTurn.id, "tool_call.repair.requested"],
      ["other-repair", "other-task", f.other.id, "tool_call.repair.requested"], ["other-event", "task", f.target.id, "tool_call.parse.failed"]]) {
      storage.db.prepare("insert into trace_events (id,session_id,task_id,turn_id,type,source,payload_json,created_at) values (?,?,?,?,?,?,?,?)")
        .run(id, "session", taskId, turnId, type, "AgentLoop", "{}", "2026-10-15 12:00:00.000");
    }
    const result = f.measure(["prefix-1", "prefix-2"]);
    expect(result).toMatchObject({ requestCount: 3, turnRequestCount: 2, summaryRequestCount: 1,
      knownPromptTokens: 30, knownCompletionTokens: 5, missingUsageRequestCount: 1,
      httpDurationMs: 90, failedRequestCount: 1, completedToolCount: 1, protocolRepairCount: 1, prefixRequestIdsMatch: true });
    const first = storage.db.prepare("select length(request_body_json) as chars from llm_http_captures where request_id = 'new-1'").get() as { chars: number };
    expect(result.firstTurnRequestChars).toBe(first.chars);
  });

  it("counts unavailable, absent and partial usage as missing while preserving known fields and real zero", async () => {
    const f = await fixture();
    f.capture("zero", { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    f.capture("unavailable", { usage: null });
    f.capture("absent", { usage: null });
    storage.db.prepare("delete from token_usage where request_id = 'absent'").run();
    f.capture("partial", { usage: { prompt_tokens: 7 } });
    f.capture("no-total", { usage: { prompt_tokens: 3, completion_tokens: 2 } });
    expect(storage.db.prepare("select status, prompt_tokens, completion_tokens from token_usage where request_id = 'unavailable'").get())
      .toEqual({ status: "unavailable", prompt_tokens: null, completion_tokens: null });
    expect(f.measure()).toMatchObject({ requestCount: 5, knownPromptTokens: 10, knownCompletionTokens: 2, missingUsageRequestCount: 4 });
  });

  it("checks all three summaries against each first following turn request", async () => {
    const f = await fixture();
    f.capture("prefix", { turnId: f.oldTurn.id });
    const entries = prefixMessages.map((message, index) => {
      const summaryRequestId = `summary-${index}`;
      const summaryMarkdown = `## Goal\n摘要 ${index}：完整的多行\n包含引号 \"path\"`;
      f.capture(summaryRequestId, { purpose: "task_compaction" });
      const entry = f.entry(summaryRequestId, message.sourceRef, summaryMarkdown);
      f.capture(`next-${index}`, { messages: [{ role: "system", content: "规则" }, { role: "user", content: `前导\n${summaryMarkdown}\n结尾` },
        ...prefixMessages.slice(index).map((item) => item.message)] });
      return entry;
    });
    const result = f.measure(["prefix"]);
    expect(result).toMatchObject({ requestCount: 6, turnRequestCount: 3, summaryRequestCount: 3, missingUsageRequestCount: 0 });
    expect(result.summaryChecks).toEqual(entries.map((entry, index) => ({ entryId: entry.id, summaryRequestId: `summary-${index}`,
      nextRequestId: `next-${index}`, summaryInNextRequest: true, firstKeptSourceRef: prefixMessages[index].sourceRef,
      retainedPrefixMessages: 3 - index, retainedPrefixUnchanged: true })));
  });

  it("does not count copied prefix summaries as new summary checks", async () => {
    const f = await fixture();
    f.capture("old-summary", { purpose: "task_compaction", turnId: f.oldTurn.id });
    f.entry("old-summary");
    expect(f.measure(["old-summary"])).toMatchObject({ requestCount: 0, summaryRequestCount: 0,
      firstTurnRequestChars: null, prefixRequestIdsMatch: true, summaryChecks: [] });
  });

  it("reports a missing following request without claiming summary or prefix validation passed", async () => {
    const f = await fixture();
    f.capture("summary", { purpose: "task_compaction" });
    const entry = f.entry("summary");
    expect(f.measure().summaryChecks).toEqual([{ entryId: entry.id, summaryRequestId: "summary", nextRequestId: null,
      summaryInNextRequest: false, firstKeptSourceRef: prefixMessages[1].sourceRef, retainedPrefixMessages: 2, retainedPrefixUnchanged: false }]);
    expect(f.measure().firstTurnRequestChars).toBeNull();
  });

  it("reports zero checkable prefix messages as unchecked even when the summary is included", async () => {
    const f = await fixture();
    f.capture("summary", { purpose: "task_compaction" });
    f.entry("summary", "turn:branch:user");
    f.capture("next", { messages: [{ role: "user", content: "## Goal\n分支摘要" }] });
    expect(f.measure().summaryChecks[0]).toMatchObject({ summaryInNextRequest: true, retainedPrefixMessages: 0, retainedPrefixUnchanged: false });
  });

  it.each(["content", "role", "order", "gap"])("detects a retained prefix changed by %s", async (change) => {
    const f = await fixture();
    f.capture("summary", { purpose: "task_compaction" });
    f.entry("summary", prefixMessages[0].sourceRef);
    const messages = prefixMessages.map((item) => ({ ...item.message }));
    if (change === "content") messages[1].content = "被改写的答复";
    if (change === "role") messages[1].role = "user";
    if (change === "order") messages.reverse();
    if (change === "gap") messages.splice(1, 0, { role: "user", content: "不连续的插入" });
    f.capture("next", { messages: [{ role: "user", content: "## Goal\n分支摘要" }, ...messages] });
    expect(f.measure().summaryChecks[0]).toMatchObject({ nextRequestId: "next", summaryInNextRequest: true,
      retainedPrefixMessages: 3, retainedPrefixUnchanged: false });
  });

  it("uses the first subsequent turn request instead of a later successful reconstruction", async () => {
    const f = await fixture();
    f.capture("summary", { purpose: "task_compaction" });
    f.entry("summary");
    f.capture("first-next", { messages: [] });
    f.capture("later-next", { messages: [{ role: "user", content: "## Goal\n分支摘要" }, ...prefixMessages.slice(1).map((item) => item.message)] });
    expect(f.measure().summaryChecks[0]).toMatchObject({ nextRequestId: "first-next", summaryInNextRequest: false, retainedPrefixUnchanged: false });
  });

  it.each([
    { expected: ["a", "b"], actual: ["a", "b"], matches: true },
    { expected: ["a", "b"], actual: ["b", "a"], matches: false },
    { expected: ["a", "b"], actual: ["a"], matches: false },
    { expected: ["a", "b"], actual: ["a", "extra", "b"], matches: false }
  ])("matches the complete natural request prefix in order: $actual", async ({ expected, actual, matches }) => {
    const f = await fixture();
    for (const id of actual) f.capture(id, { turnId: f.oldTurn.id });
    expect(f.measure(expected).prefixRequestIdsMatch).toBe(matches);
  });

  it("compares native tool messages structurally, including call IDs and arguments", async () => {
    const f = await fixture();
    const messages: PrefixMessage[] = [
      { sourceRef: "request:tool:response", message: { role: "assistant", content: "", toolCalls: [{ id: "call", name: "read_file", input: { path: "x", limit: 1 } }] } },
      { sourceRef: "tool:call:result", message: { role: "tool", toolCallId: "call", content: "原始结果" } }
    ];
    f.capture("summary", { purpose: "task_compaction" });
    f.entry("summary", messages[0].sourceRef);
    f.capture("next", { messages: [{ role: "user", content: "## Goal\n分支摘要" },
      { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "read_file", arguments: '{"limit":1,"path":"x"}' } }] },
      { role: "tool", tool_call_id: "call", content: "原始结果" }] });
    expect(f.measure([], messages).summaryChecks[0]).toMatchObject({ retainedPrefixMessages: 2, retainedPrefixUnchanged: true });
    const changed = structuredClone(messages);
    changed[0].message.toolCalls![0].input.path = "wrong";
    expect(f.measure([], changed).summaryChecks[0].retainedPrefixUnchanged).toBe(false);
  });

  it("is read-only and never needs headers to measure malformed or incomplete request bodies", async () => {
    const f = await fixture();
    f.capture("summary", { purpose: "task_compaction" });
    f.entry("summary");
    f.capture("next", { requestBody: "not a message object", status: 0 });
    storage.db.prepare("update llm_http_captures set request_headers_json = 'not-json', response_headers_json = 'not-json'").run();
    const changes = storage.db.prepare("select total_changes() as n").get();
    storage.db.exec("PRAGMA query_only = ON");
    expect(f.measure()).toMatchObject({ failedRequestCount: 1, summaryChecks: [expect.objectContaining({ summaryInNextRequest: false, retainedPrefixUnchanged: false })] });
    expect(storage.db.prepare("select total_changes() as n").get()).toEqual(changes);
  });
});
