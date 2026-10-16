import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceInspectorQueryService } from "../../src/ui/trace-inspector-query-service.js";
import { WorkspaceQueryService } from "../../src/ui/workspace-query-service.js";

const time = "2026-10-16 12:00:00.123";
const secret = "local-config-key-private";
let root: string;
let storage: StorageManager;
let service: TraceInspectorQueryService;
const json = JSON.stringify;

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  storage.db.prepare(`insert into ${table} (${keys.join(",")}) values (${keys.map(() => "?").join(",")})`)
    .run(...Object.values(row) as (string | number | null)[]);
}
function trace(id: string, type: string, payload: object = {}, turnId: string | null = "turn-a") {
  insert("trace_events", { id, session_id: "ses", task_id: "task-a", turn_id: turnId, type, source: "AgentLoop", payload_json: json(payload), created_at: time });
}
function capture(id: string, taskId: string | null = "task-a", turnId = "turn-a") {
  insert("llm_http_captures", { id: `cap-${id}`, session_id: "ses", task_id: taskId, turn_id: turnId,
    request_id: id, provider: "test", model: "test", purpose: id.startsWith("summary") ? "task_compaction" : "turn",
    url: "https://example.test/?apiKey=private-query", method: "POST", request_headers_json: json({ Authorization: "private-header" }),
    request_body_json: json({ messages: [{ role: "user", content: secret }], apiKey: "private-body" }),
    response_status: 200, response_status_text: "OK", response_headers_json: json({ cookie: "private-cookie" }),
    response_body_json: json({ content: secret, password: "private-password" }), duration_ms: 3, created_at: time });
}
function entry(id = "entry-a", seq = 1, taskId = "task-a") {
  insert("context_compactions", { id, task_id: taskId, seq, first_kept_source_ref: "tool:tool-row-a,tool-row-b:result",
    source_refs_json: json(["turn:turn-a:user"]), summary_markdown: `## 目标\n${secret}`,
    details_json: json({ requestIds: ["summary-1", "summary-2"], readFiles: [secret], modifiedFiles: [], isSplitTurn: true, estimateSource: "estimate" }),
    tokens_before: 30000, request_id: "summary-2", created_at: time });
}
function message(ref: string, omitted = 0) {
  insert("context_messages", { source_ref: ref, task_id: "task-a", turn_id: "turn-a", message_json: json({ role: "user", content: secret }),
    usage_json: null, usage_scope: "scope", stop_reason: null, omitted, created_at: time });
}

/** 两个无 Task 的旧 Session 保留相同尝试引用，检验兼容归组不会跨 Session。 */
function legacyFixture() {
  for (const suffix of ["a", "b"]) {
    const sessionId = `ses_legacy_${suffix}`;
    const turnId = `old-turn-${suffix}`;
    insert("sessions", { id: sessionId, cwd: root, status: "completed", started_at: time });
    insert("turns", { id: turnId, session_id: sessionId, task_id: null, input: "历史输入", status: "completed", created_at: time });
    capture(`old-request-${suffix}`, null, turnId);
    storage.db.prepare("update llm_http_captures set session_id = ? where request_id = ?").run(sessionId, `old-request-${suffix}`);
    insert("trace_events", { id: `old-call-${suffix}`, session_id: sessionId, task_id: null, turn_id: turnId,
      type: "llm.called", source: "AgentLoop", payload_json: json({ requestId: `old-request-${suffix}`, contextPackId: `old-pack-${suffix}`,
        compactionAttemptId: "shared-attempt", projection: { compactionEntryId: null, sourceRefs: [], usageScope: "old-scope" } }), created_at: time });
    insert("trace_events", { id: `old-session-${suffix}`, session_id: sessionId, task_id: null, turn_id: null,
      type: "compaction.failed", source: "CompactionService", payload_json: json({ compactionAttemptId: "shared-attempt", requestIds: ["old-request-a", "old-request-b"] }), created_at: time });
    insert("context_packs", { id: `old-pack-${suffix}`, session_id: sessionId, task_id: null, turn_id: turnId, estimated_tokens: 1, created_at: time });
    insert("tool_calls", { id: `old-tool-${suffix}`, session_id: sessionId, turn_id: turnId, tool_name: "read_file", input_json: "{}", status: "completed", started_at: time });
    insert("ui_events", { event_id: `old-ui-${suffix}`, session_id: sessionId, task_id: null, turn_id: null, kind: "run.updated", payload_json: "{}", created_at: time });
    for (const [id, artifactTurn] of [[`old-artifact-${suffix}`, null], [`old-turn-artifact-${suffix}`, turnId]]) {
      insert("artifacts", { id, session_id: sessionId, task_id: null, turn_id: artifactTurn, type: "report", path: `${id}.md`, bytes: 1, created_at: time });
    }
  }
  insert("sessions", { id: "ses_no_history", cwd: root, status: "completed", started_at: time });
  insert("ui_events", { event_id: "no-history-ui", session_id: "ses_no_history", task_id: null, turn_id: null, kind: "run.updated", payload_json: "{}", created_at: time });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "figo-trace-inspector-"));
  storage = await StorageManager.init(root);
  insert("sessions", { id: "ses", cwd: root, status: "active", started_at: time });
  for (const suffix of ["a", "b"]) {
    insert("tasks", { id: `task-${suffix}`, session_id: "ses", title: suffix, status: "active", created_at: time, updated_at: time });
    insert("turns", { id: `turn-${suffix}`, session_id: "ses", task_id: `task-${suffix}`, task_seq: 1, input: secret, status: "completed", created_at: time });
  }
  service = new TraceInspectorQueryService(storage, [secret]);
});
afterEach(async () => {
  storage?.db.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("统一事实列表", () => {
  it("历史虚拟Task按Session读取原始无Task事实，游标仍绑定alias且支持latest", () => {
    legacyFixture();
    const alias = String(new WorkspaceQueryService(storage).tasks("ses_legacy_a").find(task => task.id === "legacy_ses_legacy_a")!.id);
    const before = storage.db.prepare("select total_changes() as n").get();
    storage.db.exec("PRAGMA query_only = ON");
    const all = service.listEvents(alias);
    expect(all.events.map(event => event.key)).toEqual(["trace:old-call-a", "trace:old-session-a", "capture:cap-old-request-a", "tool:old-tool-a", "context:old-pack-a", "ui:old-ui-a"]);
    expect(all.events.every(event => event.taskId === null && event.sessionId === "ses_legacy_a")).toBe(true);
    const first = service.listEvents(alias, { limit: 2 });
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")).task).toBe(alias);
    const next = service.listEvents(alias, { cursor: first.nextCursor!, limit: 2 });
    expect(next.events.map(event => event.key)).toEqual(["capture:cap-old-request-a", "tool:old-tool-a"]);
    expect(service.listEvents(alias, { latest: true, limit: 2 }).events.map(event => event.key)).toEqual(["context:old-pack-a", "ui:old-ui-a"]);
    expect(() => service.listEvents("legacy_ses_legacy_b", { cursor: first.nextCursor! })).toThrow(/游标/);
    expect(() => service.listEvents(alias, { cursor: first.nextCursor!, failed: true })).toThrow(/游标/);
    expect(service.listEvents("legacy_ses_no_history").events).toEqual([]);
    expect(storage.db.prepare("select total_changes() as n").get()).toEqual(before);
  });

  it("latest返回最近窗口的正序快照，重查可发现迟落库工具与同毫秒低rank事件", () => {
    capture("request-1");
    const first = service.listEvents("task-a", { latest: true, limit: 2 });
    expect(first.events.map(event => event.key)).toEqual(["capture:cap-request-1"]);
    trace("late-low-rank", "llm.completed");
    expect(service.listEvents("task-a", { latest: true, limit: 2 }).events.map(event => event.key)).toEqual(["trace:late-low-rank", "capture:cap-request-1"]);
    insert("tool_calls", { id: "late-tool", session_id: "ses", turn_id: "turn-a", tool_name: "read_file", input_json: "{}", status: "completed", started_at: "2026-10-16 11:59:59.000" });
    expect(service.listEvents("task-a", { latest: true, limit: 3 }).events.map(event => event.key)).toEqual(["tool:late-tool", "trace:late-low-rank", "capture:cap-request-1"]);
    const limited = service.listEvents("task-a", { latest: true, limit: 2 });
    expect(limited.hasMore).toBe(true);
    expect(limited.truncated).toBe(true);
    expect(limited.nextCursor).toBeNull();
    expect(() => service.listEvents("task-a", { latest: true, cursor: first.endCursor! })).toThrow(/游标/);
  });

  it("尾游标可轮询小列表增量，支持同毫秒同类别追加并校验筛选范围", () => {
    trace("first", "llm.called", { requestId: "needle" });
    const first = service.listEvents("task-a", { category: "trace", q: "needle" });
    expect(first.nextCursor).toBeNull();
    expect(first.endCursor).toEqual(expect.any(String));
    expect(first.hasMore).toBe(false);
    trace("second", "llm.called", { requestId: "needle" });
    const second = service.listEvents("task-a", { category: "trace", q: "needle", cursor: first.endCursor! });
    expect(second.events.map(row => row.key)).toEqual(["trace:second"]);
    expect(second.endCursor).not.toBe(first.endCursor);
    expect(second.nextCursor).toBeNull();
    expect(service.listEvents("task-a", { category: "trace", q: "needle", cursor: second.endCursor! }).events).toEqual([]);
    expect(service.listEvents("task-b").endCursor).toBeNull();
    expect(() => service.listEvents("task-a", { category: "tool", cursor: first.endCursor! })).toThrow(/游标/);
  });

  it("汇总八类事实，保留身份并稳定分页同毫秒记录", () => {
    trace("trace-1", "llm.called", { requestId: "request-1" });
    capture("request-1");
    insert("tool_calls", { id: "tool-row-a", intent_id: "intent-a", session_id: "ses", turn_id: "turn-a", tool_name: "read_file", input_json: "{}", status: "completed", started_at: time });
    insert("context_packs", { id: "pack-a", session_id: "ses", task_id: "task-a", turn_id: "turn-a", estimated_tokens: 5, created_at: time });
    entry();
    insert("task_compaction_checkpoints", { id: "legacy-a", task_id: "task-a", from_seq: 1, through_seq: 1,
      source_turn_ids_json: '["turn-a"]', summary_json: '{"goal":"旧版"}', request_id: "legacy-request", created_at: time });
    message("tool:tool-row-a,tool-row-b:result");
    insert("ui_events", { event_id: "ui-1", session_id: "ses", task_id: "task-a", turn_id: "turn-a", kind: "run.updated", payload_json: "{}", created_at: time });
    trace("trace-2", "turn.completed");
    const expected = service.listEvents("task-a").events.map(row => row.key);
    expect(expected).toEqual(["trace:trace-1", "trace:trace-2", "capture:cap-request-1", "tool:tool-row-a", "context:pack-a", "compaction:entry-a", "legacy-compaction:legacy-a", `message:${encodeURIComponent("tool:tool-row-a,tool-row-b:result")}`, "ui:ui-1"]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.listEvents("task-a", { limit: 2, cursor });
      expect(page.truncated).toBe(page.hasMore);
      seen.push(...page.events.map(row => row.key));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(service.listEvents("task-b").events).toEqual([]);
  });

  it("支持类别、失败、文字筛选，拒绝无效或跨范围游标", () => {
    trace("bad", "policy.denied", { reason: secret });
    trace("good", "llm.called", { requestId: "needle" });
    trace("repair", "llm.protocol.repair", {});
    expect(service.listEvents("task-a", { failed: true }).events.map(row => row.key)).toEqual(["trace:bad", "trace:repair"]);
    expect(service.listEvents("task-a", { category: ["trace"], q: "needle" }).events.map(row => row.key)).toEqual(["trace:good"]);
    const cursor = service.listEvents("task-a", { limit: 1 }).nextCursor!;
    for (const invalid of ["bad", "eyJzcWwiOiJEUk9QIn0", "" ]) {
      expect(() => service.listEvents("task-a", { cursor: invalid })).toThrow(/游标/);
    }
    expect(() => service.listEvents("task-b", { cursor })).toThrow(/游标/);
    expect(() => service.listEvents("task-a", { cursor, q: "changed" })).toThrow(/游标/);
    expect(() => service.listEvents("task-a", { limit: -1 })).toThrow();
    expect(() => service.detail("trace:missing")).toThrow();
    expect(() => service.detail("unknown:anything")).toThrow();
  });

  it("默认200最大500，列表不读取模型或消息正文", () => {
    for (let i = 0; i < 505; i++) trace(`trace-${i}`, "turn.completed", { secret, huge: "x".repeat(2000) });
    expect(service.listEvents("task-a").events).toHaveLength(200);
    expect(service.listEvents("task-a", { limit: 1000 }).events).toHaveLength(500);
    capture("request-1");
    const list = json(service.listEvents("task-a", { category: ["capture"] }));
    expect(list).not.toContain("messages");
    expect(list).not.toContain("private-body");
  });

  it("长sourceRef仍有完整稳定key，列表响应预算通过减少条目数保持引用可用", () => {
    for (let i = 0; i < 20; i++) message(`request:${i}:${"a".repeat(60000)}:response`);
    const page = service.listEvents("task-a");
    expect(page.truncated).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.events.length).toBeGreaterThan(0);
    expect(json(page).length).toBeLessThan(1_100_000);
    const detail = service.detail(page.events[0].key);
    expect(detail.messages.some(item => item.sourceRef === page.events[0].refs.sourceRef)).toBe(true);
    expect(detail.messages.every(item => item.sourceRef.length > 60000)).toBe(true);
  });
});

describe("详情证据边界", () => {
  it("合法Task/Turn/Pack中的错误摘要引用也不能带入另一Task的边界", () => {
    trace("own-call", "llm.called", { requestId: "own-request", contextPackId: "own-pack" });
    capture("own-request");
    insert("context_packs", { id: "own-pack", session_id: "ses", task_id: "task-a", turn_id: "turn-a", estimated_tokens: 1, created_at: time });
    entry("foreign-entry", 1, "task-b");
    storage.db.prepare("update context_compactions set first_kept_source_ref = ?, source_refs_json = ? where id = ?")
      .run("foreign-private-boundary", json(["foreign-private-source"]), "foreign-entry");
    insert("context_items", { id: "bad-ref", context_pack_id: "own-pack", source_type: "task_compaction", source_ref: "task.compaction:foreign-entry",
      content: "本Task当时记录的摘要快照", summary: "已记录快照", estimated_tokens: 1, included: 1, reason: "历史构建记录" });
    const detail = service.detail("trace:own-call");
    expect(detail.context.pack?.id).toBe("own-pack");
    expect(detail.context.checkpoint).toBeNull();
    expect(json(detail)).not.toContain("foreign-private-boundary");
    expect(json(detail)).not.toContain("foreign-private-source");
    expect(detail.limitations.some(item => item.includes("检查点") && item.includes("归属"))).toBe(true);
  });
  it.each(["pack-task", "turn-task", "pack-session", "turn-session"])("上下文先校验Task和Session归属，拒绝错误引用组合 %s", (scenario) => {
    const foreignBody = "foreign-context-body-must-not-leak";
    insert("sessions", { id: "ses_else", cwd: root, status: "active", started_at: time });
    const turnId = scenario === "pack-task" || scenario === "turn-task" ? "turn-b" : "turn-a";
    if (scenario === "turn-session") storage.db.prepare("update turns set session_id = 'ses_else' where id = 'turn-a'").run();
    insert("context_packs", { id: "bad-pack", session_id: scenario === "pack-session" ? "ses_else" : "ses",
      task_id: scenario === "pack-task" ? "task-b" : "task-a", turn_id: turnId, estimated_tokens: 1, created_at: time });
    insert("context_items", { id: "bad-item", context_pack_id: "bad-pack", source_type: "turn", source_ref: "turn.input",
      summary: foreignBody, content: foreignBody, estimated_tokens: 1, included: 1, reason: "错误归属引用" });
    capture("context-request");
    trace("bad-context", "llm.called", { requestId: "context-request", contextPackId: "bad-pack",
      projection: { compactionEntryId: null, sourceRefs: [], usageScope: "s" } }, turnId);
    storage.db.exec("PRAGMA query_only = ON");
    const result = service.detail("trace:bad-context");
    expect(result.context).toEqual({ pack: null, items: [], checkpoint: null });
    expect(json(result.context)).not.toContain(foreignBody);
    expect(result.limitations.some(item => item.includes("归属"))).toBe(true);
  });

  it("90条滚动摘要各200个来源时，SQL前限制关联并明确截断", () => {
    storage.db.exec("BEGIN");
    for (let seq = 1; seq <= 90; seq++) insert("context_compactions", { id: `roll-${seq}`, task_id: "task-a", seq,
      base_entry_id: seq === 1 ? null : `roll-${seq - 1}`, first_kept_source_ref: "kept",
      source_refs_json: json(Array.from({ length: 200 }, (_, index) => `r:${seq}:${index}`)), summary_markdown: "## 目标\n滚动摘要",
      details_json: '{"estimateSource":"estimate"}', tokens_before: 30000, request_id: `roll-request-${seq}`, created_at: time });
    storage.db.exec("COMMIT");
    capture("rolling-request"); message("kept"); message("r:90:0"); message("r:1:0");
    trace("rolling-call", "llm.called", { requestId: "rolling-request", projection: { compactionEntryId: "roll-90", sourceRefs: ["kept"], usageScope: "s" } });
    const before = storage.db.prepare("select total_changes() as n").get();
    storage.db.exec("PRAGMA query_only = ON");
    const result = service.detail("trace:rolling-call");
    expect(result.truncated).toBe(true);
    expect(result.limitations.some(item => item.includes("关联") && item.includes("截断"))).toBe(true);
    expect(result.selection.projection.compactionEntryId).toBe("roll-90");
    expect(result.messages.find(item => item.sourceRef === "kept")?.state).toBe("raw");
    expect(result.messages.find(item => item.sourceRef === "r:90:0")?.state).toBe("covered");
    expect(storage.db.prepare("select total_changes() as n").get()).toEqual(before);
  });

  it("从无Turn恢复摘要沿明确恢复引用找到重试抓包，不混入同Turn无关请求", () => {
    entry();
    storage.db.prepare("update context_compactions set details_json = ?").run(json({ compactionAttemptId: "recovery-attempt", recoveryOfRequestId: "failed-request", requestIds: ["summary-1", "summary-2"], estimateSource: "estimate" }));
    for (const requestId of ["failed-request", "summary-1", "summary-2", "retry-request", "unrelated-request"]) capture(requestId);
    capture("foreign-retry", "task-b", "turn-b");
    trace("retry-called", "llm.called", { requestId: "retry-request", recoveryOfRequestId: "failed-request",
      projection: { compactionEntryId: "entry-a", sourceRefs: [], usageScope: "s" } });
    trace("unrelated-called", "llm.called", { requestId: "unrelated-request" });
    insert("trace_events", { id: "foreign-retry-called", session_id: "ses", task_id: "task-b", turn_id: "turn-b", type: "llm.called", source: "AgentLoop",
      payload_json: json({ requestId: "foreign-retry", recoveryOfRequestId: "failed-request" }), created_at: time });
    storage.db.exec("PRAGMA query_only = ON");
    const result = service.detail("compaction:entry-a");
    expect(result.row.turnId).toBeNull();
    expect(result.events.some(event => event.id === "retry-called" && event.relation === "direct")).toBe(true);
    expect(result.captures.map(item => item.requestId).sort()).toEqual(["failed-request", "retry-request", "summary-1", "summary-2"]);
    expect(result.captures.find(item => item.requestId === "retry-request")?.relation).toBe("direct");
  });

  it("无Task详情按根Session隔离事件和抓包，跨Session请求选择被拒绝", () => {
    legacyFixture();
    storage.db.exec("PRAGMA query_only = ON");
    const result = service.detail("trace:old-call-a");
    expect(result.row.taskId).toBeNull();
    expect(result.selection.taskId).toBeNull();
    expect(result.events.map(event => event.id)).toEqual(["old-call-a", "old-session-a"]);
    expect(result.captures.map(item => item.requestId)).toEqual(["old-request-a"]);
    expect(result.tools.map(item => item.id)).toEqual(["old-tool-a"]);
    expect(result.context.pack?.id).toBe("old-pack-a");
    expect(() => service.detail("trace:old-call-a", { requestId: "old-request-b" })).toThrow(/归属/);
    expect(service.detail("trace:old-session-a").captures.map(item => item.requestId)).toEqual(["old-request-a"]);
  });

  it("无Task无Turn的详情不能混入其他Session的同类Artifact", () => {
    legacyFixture();
    const result = service.detail("ui:old-ui-a");
    expect(result.artifacts.map(item => item.id)).toEqual(["old-artifact-a", "old-turn-artifact-a"]);
    expect(result.artifacts.every(item => item.taskId === null)).toBe(true);
  });

  it("按attempt找到已落库但completed缺失的条目及全部摘要调用", () => {
    entry(); capture("summary-1"); capture("summary-2");
    storage.db.prepare("update context_compactions set details_json = ?").run(json({ compactionAttemptId: "persisted-attempt", requestIds: ["summary-1", "summary-2"], estimateSource: "estimate" }));
    trace("started", "compaction.started", { compactionAttemptId: "persisted-attempt" }, null);
    const result = service.detail("trace:started");
    expect(result.compactions).toEqual([expect.objectContaining({ id: "entry-a", relation: "direct", completionEventStatus: "missing" })]);
    expect(result.captures.map(capture => capture.requestId)).toEqual(["summary-1", "summary-2"]);
  });

  it("旧JSON请求显式引用可校验，但不冒充消息级覆盖；失效引用降级unknown", () => {
    insert("task_compaction_checkpoints", { id: "legacy-a", task_id: "task-a", from_seq: 1, through_seq: 1,
      source_turn_ids_json: '["turn-a"]', summary_json: '{"goal":"旧版"}', request_id: "legacy-summary", created_at: time });
    capture("legacy-request"); message("turn:turn-a:user");
    trace("legacy-call", "llm.called", { requestId: "legacy-request", projection: { compactionEntryId: null, legacyCheckpointId: "legacy-a", sourceRefs: [], usageScope: "s" } });
    let result = service.detail("trace:legacy-call");
    expect(result.selection.projection.legacyCheckpointId).toBe("legacy-a");
    expect(result.legacyCheckpoints[0].relation).toBe("direct");
    expect(result.messages[0].state).toBe("unknown");
    storage.db.prepare("delete from task_compaction_checkpoints where id = 'legacy-a'").run();
    result = service.detail("trace:legacy-call");
    expect(result.selection.projection.status).toBe("unknown");
    expect(result.limitations.some(item => item.includes("旧") && item.includes("缺失"))).toBe(true);
  });

  it("缺失成功条目的完成事件仍可检查，旧checkpoint引用按兼容数据读取", () => {
    trace("missing-entry", "compaction.completed", { checkpointId: "not-persisted", compactionAttemptId: "attempt-lost" });
    const missingRow = service.listEvents("task-a").events.find(event => event.key === "trace:missing-entry")!;
    const lost = service.detail(missingRow.key, { compactionEntryId: missingRow.refs.compactionEntryId });
    expect(lost.selection.compactionEntryId).toBe("not-persisted");
    expect(lost.compactions).toEqual([]);
    expect(lost.limitations.some(item => item.includes("条目") && item.includes("缺失"))).toBe(true);
    insert("task_compaction_checkpoints", { id: "legacy-a", task_id: "task-a", from_seq: 1, through_seq: 1,
      source_turn_ids_json: '["turn-a"]', summary_json: '{"goal":"旧版"}', request_id: "legacy-request", created_at: time });
    trace("old-complete", "compaction.completed", { checkpointId: "legacy-a" });
    expect(service.detail("trace:old-complete", { compactionEntryId: "legacy-a" }).legacyCheckpoints[0].relation).toBe("direct");
  });

  it("显式选择根引用的同Task旧JSON时只读降级，不当成消息级条目", () => {
    insert("task_compaction_checkpoints", { id: "legacy-a", task_id: "task-a", from_seq: 1, through_seq: 1,
      source_turn_ids_json: '["turn-a"]', summary_json: '{"goal":"旧版"}', request_id: "legacy-request", created_at: time });
    trace("old-complete", "compaction.completed", { checkpointId: "legacy-a" });
    const row = service.listEvents("task-a").events.find(event => event.key === "trace:old-complete")!;
    const before = storage.db.prepare("select total_changes() as n").get();
    storage.db.exec("PRAGMA query_only = ON");
    const result = service.detail(row.key, { compactionEntryId: row.refs.compactionEntryId });
    expect(result.selection.compactionEntryId).toBeNull();
    expect(result.compactions).toEqual([]);
    expect(result.legacyCheckpoints[0]).toMatchObject({ id: "legacy-a", relation: "direct", summaryJson: { goal: "旧版" } });
    expect(storage.db.prepare("select total_changes() as n").get()).toEqual(before);
    expect(() => service.detail(row.key, { compactionEntryId: "arbitrary-unknown" })).toThrow(/归属/);
  });

  it("根条目引用匹配仍拒绝已有跨Task新条目和旧JSON，兼容记录不能绕过归属", () => {
    entry("collision", 1, "task-b");
    insert("task_compaction_checkpoints", { id: "collision", task_id: "task-a", from_seq: 1, through_seq: 1,
      source_turn_ids_json: '["turn-a"]', summary_json: '{}', request_id: "legacy-request", created_at: time });
    insert("task_compaction_checkpoints", { id: "foreign-legacy", task_id: "task-b", from_seq: 1, through_seq: 1,
      source_turn_ids_json: '["turn-b"]', summary_json: '{}', request_id: "foreign-request", created_at: time });
    trace("foreign-new", "compaction.completed", { compactionEntryId: "collision" });
    trace("foreign-old", "compaction.completed", { checkpointId: "foreign-legacy" });
    trace("plain", "turn.completed");
    expect(() => service.detail("trace:foreign-new", { compactionEntryId: "collision" })).toThrow(/归属/);
    expect(() => service.detail("trace:foreign-old", { compactionEntryId: "foreign-legacy" })).toThrow(/归属/);
    expect(() => service.detail("trace:plain", { compactionEntryId: "collision" })).toThrow(/归属/);
  });

  it("从压缩条目与失败尝试接出全部请求及恢复引用", () => {
    entry(); capture("summary-1"); capture("summary-2"); capture("original"); capture("retry");
    storage.db.prepare("update context_compactions set details_json = ? where id = 'entry-a'")
      .run(json({ requestIds: ["summary-1", "summary-2"], compactionAttemptId: "attempt-1", recoveryOfRequestId: "original", estimateSource: "usage" }));
    trace("failed-call", "llm.called", { requestId: "original", projection: { compactionEntryId: null, sourceRefs: [], usageScope: "s" } });
    trace("retry-call", "llm.called", { requestId: "retry", recoveryOfRequestId: "original", projection: { compactionEntryId: "entry-a", sourceRefs: [], usageScope: "s" } });
    trace("recovery", "compaction.started", { compactionAttemptId: "attempt-1", recoveryOfRequestId: "original" });
    const summary = service.detail("compaction:entry-a");
    expect(summary.selection.compactionAttemptId).toBe("attempt-1");
    expect(summary.compactions[0].tokensBefore.kind).toBe("usage_plus_estimate");
    const retry = service.detail("capture:cap-retry");
    expect(retry.selection.recoveryOfRequestId).toBe("original");
    expect(retry.captures.find(item => item.requestId === "original")?.relation).toBe("direct");
    expect(retry.events.find(item => item.id === "recovery")?.relation).toBe("direct");
    trace("failure", "compaction.failed", { compactionAttemptId: "attempt-failed", requestIds: ["summary-1", "summary-2"] }, null);
    expect(service.detail("trace:failure").captures.map(item => item.requestId)).toEqual(["summary-1", "summary-2"]);
  });

  it("旧记录的估算来源未知，不能当Provider实测；同Turn同intent不冒充工具记录引用", () => {
    entry();
    storage.db.prepare("update context_compactions set details_json = '{}'").run();
    const detail = service.detail("compaction:entry-a");
    expect(detail.compactions[0].tokensBefore).toMatchObject({ value: 30000, kind: "unknown" });
    expect(service.listEvents("task-a", { category: "compaction" }).events[0].tokens?.kind).toBe("unknown");
    insert("tool_calls", { id: "tool-row-a", intent_id: "intent-a", session_id: "ses", turn_id: "turn-a", tool_name: "read_file", input_json: "{}", status: "completed", started_at: time });
    message("tool:intent-a:result");
    expect(service.detail(`message:${encodeURIComponent("tool:intent-a:result")}`).messages[0].toolRowIds).toEqual([]);
  });

  it("llm.called在抓包尚未落库时可读，未知来源不伪造抓包", () => {
    trace("pending", "llm.called", { requestId: "pending-request", projection: { compactionEntryId: null, sourceRefs: [], usageScope: "test" } });
    const pending = service.detail("trace:pending");
    expect(pending.selection.requestId).toBe("pending-request");
    expect(pending.captures).toEqual([]);
    expect(pending.selection.projection.status).toBe("recorded");
  });

  it("前端显式选择根pending请求时，缺失抓包降级而不阻断详情", () => {
    trace("pending", "llm.called", { requestId: "pending-request", projection: { compactionEntryId: null, sourceRefs: [], usageScope: "test" } });
    const row = service.listEvents("task-a").events.find(event => event.key === "trace:pending")!;
    const before = storage.db.prepare("select total_changes() as n").get();
    storage.db.exec("PRAGMA query_only = ON");
    const pending = service.detail(row.key, { requestId: row.refs.requestId });
    expect(pending.selection.requestId).toBe("pending-request");
    expect(pending.selection.projection.status).toBe("recorded");
    expect(pending.captures).toEqual([]);
    expect(pending.limitations.some(item => item.includes("抓包缺失"))).toBe(true);
    expect(storage.db.prepare("select total_changes() as n").get()).toEqual(before);
    expect(() => service.detail(row.key, { requestId: "arbitrary-unknown" })).toThrow(/归属/);
  });

  it("新旧压缩根引用的摘要请求缺失时，显式选择仍可读成功条目", () => {
    entry();
    insert("task_compaction_checkpoints", { id: "legacy-missing-capture", task_id: "task-a", from_seq: 1, through_seq: 1,
      source_turn_ids_json: '["turn-a"]', summary_json: '{"goal":"旧版"}', request_id: "legacy-summary-missing", created_at: time });
    storage.db.exec("PRAGMA query_only = ON");
    for (const category of ["compaction", "legacy-compaction"] as const) {
      const row = service.listEvents("task-a", { category }).events[0];
      const detail = service.detail(row.key, { requestId: row.refs.requestId });
      expect(detail.selection.requestId).toBe(row.refs.requestId);
      expect(detail.captures).toEqual([]);
      expect(detail.limitations.some(item => item.includes("抓包缺失"))).toBe(true);
      if (category === "compaction") expect(detail.compactions[0]).toMatchObject({ id: "entry-a", commitStatus: "committed" });
      else expect(detail.legacyCheckpoints[0]).toMatchObject({ id: "legacy-missing-capture", summaryJson: { goal: "旧版" } });
      expect(() => service.detail(row.key, { requestId: "arbitrary-unknown" })).toThrow(/归属/);
    }
  });

  it("根请求ID虽匹配但已有跨Task抓包时仍拒绝，不能作为缺失降级", () => {
    trace("foreign-pending", "llm.called", { requestId: "foreign-request" });
    capture("foreign-request", "task-b", "turn-b");
    expect(() => service.detail("trace:foreign-pending", { requestId: "foreign-request" })).toThrow(/归属/);
    entry();
    capture("summary-2", "task-b", "turn-b");
    expect(() => service.detail("compaction:entry-a", { requestId: "summary-2" })).toThrow(/归属/);
    legacyFixture();
    storage.db.prepare("update trace_events set payload_json = ? where id = 'old-call-a'").run(json({ requestId: "old-request-b" }));
    expect(() => service.detail("trace:old-call-a", { requestId: "old-request-b" })).toThrow(/归属/);
  });

  it("接受传输层undefined可选项，不把其他Turn的同Task请求构建快照丢弃", () => {
    trace("plain", "turn.completed");
    expect(service.detail("trace:plain", { requestId: undefined, compactionEntryId: undefined }).selection.requestId).toBeNull();
    insert("turns", { id: "turn-a2", session_id: "ses", task_id: "task-a", task_seq: 2, input: "第二轮", status: "completed", created_at: time });
    insert("context_packs", { id: "pack-a2", session_id: "ses", task_id: "task-a", turn_id: "turn-a2", estimated_tokens: 1, created_at: time });
    capture("request-a2", "task-a", "turn-a2");
    trace("call-a2", "llm.called", { requestId: "request-a2", contextPackId: "pack-a2", projection: { compactionEntryId: null, sourceRefs: [], usageScope: "s" } }, "turn-a2");
    const selected = service.detail("trace:plain", { requestId: "request-a2" });
    expect(selected.selection.turnId).toBe("turn-a");
    expect(selected.context.pack?.id).toBe("pack-a2");
  });

  it("超大来源输入与损坏JSON不会绕过详情限制或让检查器崩溃", () => {
    trace("plain", "turn.completed");
    insert("context_packs", { id: "pack-a", session_id: "ses", task_id: "task-a", turn_id: "turn-a", estimated_tokens: 1, created_at: time });
    insert("context_items", { id: "item-a", context_pack_id: "pack-a", source_type: "turn", source_ref: "turn.input", summary: "", content: "小正文", estimated_tokens: 1, included: 1, reason: "" });
    storage.db.prepare("update turns set input = ? where id = 'turn-a'").run("x".repeat(200000));
    expect(service.detail("trace:plain").truncated).toBe(true);
    storage.db.prepare("update turns set input = 'small' where id = 'turn-a'").run();
    entry();
    insert("context_items", { id: "item-b", context_pack_id: "pack-a", source_type: "task_compaction", source_ref: "task.compaction:entry-a", summary: "", content: "旧内容", estimated_tokens: 1, included: 1, reason: "" });
    storage.db.prepare("update context_compactions set source_refs_json = '{invalid json'").run();
    expect(() => service.detail("trace:plain")).not.toThrow();
  });

  it("详情不混入Task其他Turn的无关消息和摘要，滚动摘要保留基条目覆盖证据", () => {
    capture("request-1");
    message("turn:turn-a:user");
    message("request:older:response");
    entry();
    entry("entry-roll", 2);
    storage.db.prepare("update context_compactions set base_entry_id = 'entry-a', source_refs_json = '[\"request:older:response\"]' where id = 'entry-roll'").run();
    trace("call", "llm.called", { requestId: "request-1", projection: { compactionEntryId: "entry-roll", sourceRefs: [], usageScope: "scope" } });
    insert("turns", { id: "turn-a2", session_id: "ses", task_id: "task-a", task_seq: 2, input: "无关轮次", status: "completed", created_at: time });
    insert("context_messages", { source_ref: "turn:turn-a2:user", task_id: "task-a", turn_id: "turn-a2", message_json: '{"role":"user","content":"无关消息"}', omitted: 0, created_at: time });
    entry("entry-unrelated", 3);
    const detail = service.detail("trace:call");
    expect(detail.compactions.map(item => item.id)).not.toContain("entry-unrelated");
    expect(detail.messages.map(item => item.sourceRef)).not.toContain("turn:turn-a2:user");
    expect(detail.messages.find(item => item.sourceRef === "turn:turn-a:user")?.state).toBe("covered");
  });

  it("总响应预算不会把关键ID或sourceRef改写为截断正文", () => {
    capture("request-1");
    message("turn:turn-a:user");
    trace("call", "llm.called", { requestId: "request-1", projection: { compactionEntryId: null, sourceRefs: ["turn:turn-a:user"], usageScope: "scope" } });
    for (let i = 0; i < 75; i++) trace(`large-${i}`, "turn.completed", { note: "x".repeat(16000) });
    const result = service.detail("trace:call");
    expect(result.truncated).toBe(true);
    expect(result.selection.requestId).toBe("request-1");
    expect(result.events.every(event => event.id === "call" || /^large-\d+$/.test(event.id))).toBe(true);
    expect(result.messages.every(message => message.sourceRef === "turn:turn-a:user")).toBe(true);
    expect(json(result).length).toBeLessThan(1_100_000);
  });

  it("按所选请求读取记录投影，后来的摘要和omitted不改变历史", () => {
    capture("request-1"); capture("request-2");
    for (const suffix of ["a", "b"]) insert("tool_calls", { id: `tool-row-${suffix}`, intent_id: `intent-${suffix}`, session_id: "ses", turn_id: "turn-a", tool_name: "read_file", input_json: "{}", status: "completed", started_at: time });
    message("turn:turn-a:user"); message("tool:tool-row-a,tool-row-b:result");
    trace("call-1", "llm.called", { requestId: "request-1", contextPackId: "pack-a", projection: { compactionEntryId: null, sourceRefs: ["turn:turn-a:user"], usageScope: "scope-1" } });
    entry();
    trace("call-2", "llm.called", { requestId: "request-2", projection: { compactionEntryId: "entry-a", sourceRefs: ["tool:tool-row-a,tool-row-b:result"], usageScope: "scope-2" } });
    const first = service.detail("trace:call-1");
    expect(first.selection.requestId).toBe("request-1");
    expect(first.selection.projection).toMatchObject({ status: "recorded", compactionEntryId: null, sourceRefs: ["turn:turn-a:user"] });
    entry("entry-later", 2);
    storage.db.prepare("update context_messages set omitted = 1").run();
    expect(service.detail("trace:call-1").selection).toEqual(first.selection);
    const second = service.detail("capture:cap-request-2");
    expect(second.selection.projection.compactionEntryId).toBe("entry-a");
    const batch = second.messages.find(m => m.sourceRef === "tool:tool-row-a,tool-row-b:result")!;
    expect(batch).toMatchObject({ toolRowIds: ["tool-row-a", "tool-row-b"], state: "raw", stateScope: "selected_request", omitted: true });
    expect(second.messages.find(m => m.sourceRef === "turn:turn-a:user")?.state).toBe("covered");
  });

  it("只有Turn的事件不自动选请求，旧请求来源保持unknown，选择需校验Task", () => {
    capture("request-1"); capture("request-2"); capture("other", "task-b", "turn-b");
    entry(); entry("foreign", 1, "task-b");
    trace("plain", "turn.completed");
    expect(service.detail("trace:plain").selection.requestId).toBeNull();
    expect(service.detail("capture:cap-request-1").selection.projection.status).toBe("unknown");
    const selected = service.detail("trace:plain", { requestId: "request-2", compactionEntryId: "entry-a" });
    expect(selected.selection.requestAssociation).toBe("selected");
    expect(selected.selection.projection.compactionEntryId).toBeNull();
    for (const selection of [{ requestId: "other" }, { requestId: "missing" }, { compactionEntryId: "foreign" }, { compactionEntryId: "missing" }]) {
      expect(() => service.detail("trace:plain", selection)).toThrow(/归属|不存在/);
    }
  });

  it("全部摘要请求、Markdown与旧JSON共存，提交和完成事件分别可见", () => {
    entry(); capture("summary-1"); capture("summary-2");
    insert("task_compaction_checkpoints", { id: "legacy-a", task_id: "task-a", from_seq: 1, through_seq: 1,
      source_turn_ids_json: '["turn-a"]', summary_json: '{"goal":"旧版"}', request_id: "legacy-request", created_at: time });
    let detail = service.detail("compaction:entry-a");
    expect(detail.compactions[0]).toMatchObject({ id: "entry-a", requestIds: ["summary-1", "summary-2"], commitStatus: "committed", completionEventStatus: "missing", tokensBefore: { value: 30000, kind: "estimate" }, tokensAfter: { value: null } });
    expect(detail.captures.map(c => c.requestId)).toEqual(["summary-1", "summary-2"]);
    expect(detail.captures[0].usage).toMatchObject({ status: "unavailable", totalTokens: null });
    expect(detail.legacyCheckpoints[0].summaryJson).toEqual({ goal: "旧版" });
    trace("done", "compaction.completed", { checkpointId: "entry-a", requestIds: ["summary-1", "summary-2"], tokensAfter: 18000, tokensAfterSource: "estimate", compactionAttemptId: "attempt-1" });
    detail = service.detail("trace:done");
    expect(detail.compactions[0]).toMatchObject({ completionEventStatus: "recorded", tokensAfter: { value: 18000, kind: "estimate" } });
    expect(detail.selection.compactionAttemptId).toBe("attempt-1");
  });

  it("失败和跳过没有成功条目，attempt引用连接恢复事件且不猜测同Turn因果", () => {
    trace("failed", "compaction.failed", { compactionAttemptId: "attempt-1", failedRequestId: "req-failed", retryRequestId: "req-retry" });
    trace("skip", "compaction.skipped", { reason: "no_summarizable_prefix" });
    trace("recovery", "llm.context.recovered", { compactionAttemptId: "attempt-1", failedRequestId: "req-failed", retryRequestId: "req-retry" });
    const detail = service.detail("trace:failed");
    expect(detail.compactions).toEqual([]);
    expect(detail.events.find(e => e.id === "recovery")?.relation).toBe("direct");
    expect(detail.events.find(e => e.id === "skip")?.relation).toBe("scope_only");
    expect(service.detail("trace:skip").selection.compactionEntryId).toBeNull();
  });

  it("所有区域脱敏，正文及集合受限，并可在SQLite query_only下查询", () => {
    capture("request-1"); entry(); message("turn:turn-a:user");
    trace("call", "llm.called", { requestId: "request-1", apiKey: "private-trace", note: secret });
    insert("context_packs", { id: "pack-a", session_id: "ses", task_id: "task-a", turn_id: "turn-a", estimated_tokens: 1, created_at: time });
    insert("context_items", { id: "item-a", context_pack_id: "pack-a", source_type: "turn", source_ref: "turn.input", summary: secret, content: secret, estimated_tokens: 1, included: 1, reason: secret });
    insert("tool_calls", { id: "tool-row-a", intent_id: "intent-a", session_id: "ses", turn_id: "turn-a", tool_name: "read_file", input_json: json({ password: "private-tool" }), output_json: json({ content: secret }), status: "completed", started_at: time });
    insert("artifacts", { id: "artifact-a", session_id: "ses", task_id: "task-a", turn_id: "turn-a", type: "report", path: secret, bytes: 1, created_at: time });
    insert("task_compaction_checkpoints", { id: "legacy-a", task_id: "task-a", from_seq: 1, through_seq: 1, source_turn_ids_json: '["turn-a"]', summary_json: json({ secret: "private-legacy", note: secret }), request_id: "legacy-request", created_at: time });
    const before = storage.db.prepare("select total_changes() as n").get();
    storage.db.exec("PRAGMA query_only = ON");
    const detail = service.detail("trace:call");
    const result = json(detail);
    for (const raw of [secret, "private-trace", "private-header", "private-body", "private-cookie", "private-password", "private-query", "private-tool", "private-legacy"]) expect(result).not.toContain(raw);
    expect(detail.tools[0]).toMatchObject({ id: "tool-row-a", intentId: "intent-a", relation: "scope_only" });
    service.listEvents("task-a");
    expect(storage.db.prepare("select total_changes() as n").get()).toEqual(before);
    storage.db.exec("PRAGMA query_only = OFF");
    storage.db.prepare("update llm_http_captures set response_body_json = ?").run(json({ note: "x".repeat(100000), password: secret }));
    for (let i = 0; i < 205; i++) trace(`extra-${i}`, "turn.completed");
    const bounded = service.detail("trace:call");
    expect(bounded.truncated).toBe(true);
    expect(bounded.limitations.some(l => l.includes("截断"))).toBe(true);
    expect(json(bounded).length).toBeLessThan(1_100_000);
  });
});
