import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTraceInspectorFixture } from "../../e2e/trace-inspector-fixture.js";

it("隔离验收数据保留安全消息切点、多摘要请求与真实抓包正文", async () => {
  const root = await mkdtemp(join(tmpdir(), "figo-inspector-fixture-"));
  let fixture: Awaited<ReturnType<typeof createTraceInspectorFixture>> | undefined;
  try {
    fixture = await createTraceInspectorFixture(root);
    const db = fixture.kernel.storage.db;
    const entry = db.prepare("select first_kept_source_ref, details_json from context_compactions where id = ?").get(fixture.compactionEntryId) as { first_kept_source_ref: string; details_json: string };
    expect(JSON.parse(entry.details_json).requestIds).toEqual(["fixture_summary_history", "fixture_summary_prefix"]);
    const kept = db.prepare("select message_json from context_messages where source_ref = ?").get(entry.first_kept_source_ref) as { message_json: string };
    expect(JSON.parse(kept.message_json).role).toBe("assistant");
    const captures = db.prepare("select request_body_json, request_headers_json from llm_http_captures order by rowid").all() as Array<{ request_body_json: string; request_headers_json: string }>;
    expect(captures).toHaveLength(5);
    expect(JSON.stringify(captures)).not.toContain("fixture-only-secret");
    const wire = JSON.parse(captures[1].request_body_json);
    expect(wire.messages[1].tool_calls[0].function.name).toBe("read_file");
    expect(wire.messages[2].tool_call_id).toBe("fixture_intent_read");
    const last = JSON.parse(captures.at(-1)!.request_body_json);
    expect(last.messages[1].content).toContain("## 目标");
    expect(last.messages.at(-1).content).toBe("继续核对实际请求与摘要边界");
  } finally {
    fixture?.kernel.storage.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
