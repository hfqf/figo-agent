import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { evaluatePiCompactionFollowup, runPiCompactionReal } from "../../e2e/pi-compaction-real.js";
import type { PiCompactionBranchMeasurements } from "../../e2e/pi-compaction-measurements.js";
import type { AcceptanceScenario } from "../../e2e/pi-compaction-settings.js";
import { StorageManager } from "../../src/storage/storage-manager.js";

let root = "";
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });

const correctFacts = "contextTokens > contextWindow - reserveTokens；16384、20000；Task隔离，SQLite原文保留。";
function evaluationFixture(scenario: AcceptanceScenario = "auto-test-window") {
  const metrics: PiCompactionBranchMeasurements = {
    requestCount: 3, turnRequestCount: 2, summaryRequestCount: 1, knownPromptTokens: 100, knownCompletionTokens: 20,
    missingUsageRequestCount: 0, httpDurationMs: 10, failedRequestCount: 0, completedToolCount: 1,
    protocolRepairCount: 0, firstTurnRequestChars: 500, prefixRequestIdsMatch: true,
    summaryChecks: [{ entryId: "new-entry", summaryRequestId: "summary", nextRequestId: "next", summaryInNextRequest: true,
      firstKeptSourceRef: "kept", retainedPrefixMessages: 2, retainedPrefixUnchanged: true }]
  };
  return { scenario, resultStatus: "completed" as const, message: correctFacts, requestedFileReadPassed: true, metrics,
    decisions: [{ type: "compaction.completed", payload_json: JSON.stringify({ mode: "auto", checkpointId: "new-entry" }), created_at: "2026-10-15 12:00:00.000" }] };
}

it.each(["auto-test-window", "stress-test-window", "manual"] as const)("%s 不能用 recovery 替代指定触发模式", (scenario) => {
  const input = evaluationFixture(scenario);
  input.decisions[0].payload_json = JSON.stringify({ mode: "recovery", checkpointId: "new-entry" });
  expect(evaluatePiCompactionFollowup(input)).toMatchObject({ followupFactsAndToolsPassed: true, projectionPassed: true, triggerModePassed: false, passed: false });
});

it.each([
  ["auto-test-window", "auto"], ["stress-test-window", "auto"], ["manual", "manual"]
] as const)("%s 接受匹配新摘要的 %s 完成事件", (scenario, mode) => {
  const input = evaluationFixture(scenario);
  input.decisions[0].payload_json = JSON.stringify({ mode, checkpointId: "new-entry" });
  expect(evaluatePiCompactionFollowup(input).passed).toBe(true);
});

it.each([
  { type: "compaction.completed", payload_json: JSON.stringify({ mode: "auto", checkpointId: "copied-entry" }) },
  { type: "compaction.started", payload_json: JSON.stringify({ mode: "auto", checkpointId: "new-entry" }) },
  { type: "compaction.completed", payload_json: "invalid-json" },
  { type: "compaction.completed", payload_json: "null" }
])("不接受旧摘要、未完成或无效的触发证据 %#", (decision) => {
  const input = evaluationFixture();
  input.decisions = [{ ...decision, created_at: "2026-10-15 12:00:00.000" }];
  expect(evaluatePiCompactionFollowup(input).triggerModePassed).toBe(false);
});

it.each([
  "contextTokens >= contextWindow - reserveTokens，即大于等于", "contextTokens ≥ contextWindow - reserveTokens",
  "contextTokens >= contextWindow - reserveTokens，大于等于也触发", "严格大于窗口减预留量",
  "contextTokens > contextWindow - reserveTokens + 1", "othercontextTokens > contextWindow - reserveTokens",
  "contextTokens > contextWindow - reserveTokensExtra", "return stats.contextTokens >= stats.contextWindow - settings.reserveTokens"
])("公式反例必须保守不通过：%s", (formula) => {
  const input = evaluationFixture();
  input.message = `${formula}；16384、20000；Task与SQLite。`;
  expect(evaluatePiCompactionFollowup(input)).toMatchObject({ factChecks: { formula: false }, passed: false });
});

it.each([
  "contextTokens > contextWindow - reserveTokens", "**contextTokens** > (**contextWindow** − **reserveTokens**)",
  "`(contextTokens) > (contextWindow - reserveTokens)`",
  "return contextTokens > contextWindow - settings.reserveTokens；关键边界：严格 >，等于阈值时不触发",
  "return stats.contextTokens > stats.contextWindow - settings.reserveTokens",
  "`(stats.contextTokens) > (stats.contextWindow − settings.reserveTokens)`",
  "公式 contextTokens > contextWindow - reserveTokens；不是 >=，等于不触发",
  "公式 contextTokens > contextWindow - reserveTokens；不是 ≥ 或大于等于，等于不触发",
  "contextTokens > contextWindow - reserveTokens\n- 等于阈值不触发\n- 保留原始来源",
  "return stats.contextTokens > stats.contextWindow - settings.reserveTokens\n\n- 下一项边界说明"
])("规范严格公式支持排版归一化：%s", (formula) => {
  const input = evaluationFixture();
  input.message = `${formula}；16384、20000；Task与SQLite。`;
  expect(evaluatePiCompactionFollowup(input).passed).toBe(true);
});

it("任意完成工具不能替代目标文件读取，投影失败也不能放行", () => {
  const input = evaluationFixture();
  input.requestedFileReadPassed = false;
  expect(evaluatePiCompactionFollowup(input)).toMatchObject({ followupFactsAndToolsPassed: false, passed: false });
  input.requestedFileReadPassed = true;
  input.metrics.summaryChecks[0].retainedPrefixUnchanged = false;
  expect(evaluatePiCompactionFollowup(input)).toMatchObject({ projectionPassed: false, passed: false });
});

it("off 无需摘要，缺 usage 不改变纯功能判定", () => {
  const input = evaluationFixture("off");
  input.metrics.summaryChecks = [];
  input.metrics.summaryRequestCount = 0;
  input.metrics.missingUsageRequestCount = input.metrics.requestCount;
  expect(evaluatePiCompactionFollowup(input)).toMatchObject({ passed: true, triggerModePassed: true });
});

it("缺少凭据时阻止真实模型验收，并在独立 SQLite 留痕而非报告占位通过", async () => {
  root = await mkdtemp(join(tmpdir(), "figo-real-preflight-"));
  await writeFile(join(root, "figo-agent.config.json"), JSON.stringify({ llm: ["a", "b", "c"].map((id) => ({ id, enabled: true, provider: "openai-compatible", apiKey: "", baseUrl: "https://unused.example", model: id })), activeModelId: "a" }));
  const network = vi.spyOn(globalThis, "fetch");
  const outputRoot = join(root, "evidence");
  const result = await runPiCompactionReal({ configRoot: root, outputRoot });
  expect(result.status).toBe("blocked");
  expect(result.results).toEqual([]);
  expect(network).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(outputRoot, "report.json"), "utf8")).preflight.every((item: { credentialConfigured: boolean }) => !item.credentialConfigured)).toBe(true);
  const storage = await StorageManager.init(join(outputRoot, "audit"));
  try {
    expect(storage.db.prepare("select count(*) as count from llm_http_captures").get()).toMatchObject({ count: 0 });
    const row = storage.db.prepare("select payload_json from trace_events where type = 'error.occurred'").get() as { payload_json: string };
    expect(JSON.parse(row.payload_json).reason).toBe("credentials_missing");
    expect(JSON.parse(row.payload_json).providers.map((item: { readyForRemoteCall: boolean }) => item.readyForRemoteCall)).toEqual([false, false, false]);
  } finally { storage.db.close(); }
});

async function configuredFixture(longSource: boolean, settings: Record<string, unknown> = {}) {
  root = await mkdtemp(join(tmpdir(), "figo-real-runner-"));
  for (const directory of ["context", "loop", "config"]) {
    if (longSource) await cp(fileURLToPath(new URL(`../../src/${directory}`, import.meta.url)), join(root, "src", directory), { recursive: true });
    else await mkdir(join(root, "src", directory), { recursive: true });
  }
  const config = { activeModelId: "a", llm: ["a", "b", "c"].map((id) => ({ id, enabled: true, provider: "openai-compatible", apiKey: "test-key", baseUrl: "https://unused.example/v1", model: id, toolCallingMode: "native", ...(id !== "c" ? { contextWindow: 128000, maxTokens: 4096 } : {}) })),
    acceptance: { piCompaction: { timeoutMs: 180000, pairRepetitions: 1, testContextWindow: 49152, stressContextWindow: 35440,
      sourceSnapshotMinChars: 100000, sourceChunkMaxChars: 16000, scenarios: ["off", "auto-test-window", "manual"], ...settings } } };
  await writeFile(join(root, "figo-agent.config.json"), JSON.stringify(config));
  return join(root, "evidence");
}

function mockFollowupProvider(toolName = "read_file", path = "src/context/compaction-policy.ts", includeUsage = true) {
  let call = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const body = JSON.parse(String(init?.body));
    const invokes = body.tools && body.messages.at(-1)?.role !== "tool" && String(body.messages.at(-1)?.content).includes("请先调用 read_file");
    const content = !body.tools ? "## Goal\n保留源码审查目标和默认参数。" : body.messages.at(-1)?.role === "tool" ? correctFacts : "已收到源码资料。";
    return new Response(JSON.stringify({ choices: [{ message: { content, ...(invokes ? { tool_calls: [{ id: `target_${++call}`, type: "function",
      function: { name: toolName, arguments: JSON.stringify({ path }) } }] } : {}) }, finish_reason: invokes ? "tool_calls" : "stop" }],
      ...(includeUsage ? { usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } } : {}) }), { status: 200 });
  });
}

it.each([
  ["path_stat", "src/context/compaction-policy.ts"], ["read_file", "src/config/runtime-config.ts"]
])("已完成的 %s(%s) 不得冒充读取指定文件", async (toolName, path) => {
  const outputRoot = await configuredFixture(true, { scenarios: ["off"] });
  mockFollowupProvider(toolName, path);
  const report = await runPiCompactionReal({ configRoot: root, outputRoot });
  const branches = report.results.filter((row) => row.scenario === "off");
  expect(branches).toHaveLength(3);
  for (const row of branches) {
    expect(row.result).toBe("completed");
    expect(row.metrics).toMatchObject({ completedToolCount: 1 });
    expect(row.followupFactsAndToolsPassed).toBe(false);
  }
  expect(report.functionalStatus).toBe("failed");
}, 30000);

it("全部窗口已声明但 usage 缺失时功能独立通过，测量不完整且总体 partial", async () => {
  const outputRoot = await configuredFixture(true, { scenarios: ["off"] });
  const configPath = join(root, "figo-agent.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.llm[2].contextWindow = 128000;
  await writeFile(configPath, JSON.stringify(config));
  mockFollowupProvider("read_file", "src/context/compaction-policy.ts", false);
  const report = await runPiCompactionReal({ configRoot: root, outputRoot });
  expect(report.errors).toEqual([]);
  expect(report).toMatchObject({ functionalStatus: "passed", capacityStatus: "declared_windows_only", measurementStatus: "incomplete", status: "partial" });
  for (const row of report.results.filter((row) => row.scenario === "off")) {
    const metrics = row.metrics as PiCompactionBranchMeasurements;
    expect(metrics.missingUsageRequestCount).toBe(metrics.requestCount);
  }
}, 30000);

it("坏 JSON 产生安全的 failed 报告和 SQLite 审计，不落盘解析错误中的原文", async () => {
  root = await mkdtemp(join(tmpdir(), "figo-real-bad-json-"));
  const secret = "fixture-secret-must-not-leak";
  await writeFile(join(root, "figo-agent.config.json"), `${secret}{`);
  const outputRoot = join(root, "evidence");
  const network = vi.spyOn(globalThis, "fetch");
  await expect(runPiCompactionReal({ configRoot: root, outputRoot })).resolves.toMatchObject({ status: "failed" });
  const reportText = await readFile(join(outputRoot, "report.json"), "utf8");
  expect(JSON.parse(reportText).errors.join("\n")).toContain("JSON");
  expect(reportText).not.toContain(secret);
  expect(network).not.toHaveBeenCalled();
  const storage = await StorageManager.init(join(outputRoot, "audit"));
  try {
    const rows = storage.db.prepare("select payload_json from trace_events where type = 'error.occurred'").all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0].payload_json).toContain("acceptance_failed");
  } finally { storage.db.close(); }
});

it("重复 outputRoot 拒绝实验并保留原报告和分支，每次追加独立拒绝审计", async () => {
  root = await mkdtemp(join(tmpdir(), "figo-real-repeated-"));
  const outputRoot = join(root, "evidence");
  await mkdir(join(outputRoot, "a", "pair-1", "off"), { recursive: true });
  const originalReport = '{"status":"original-evidence"}';
  const branchPath = join(outputRoot, "a", "pair-1", "off", "original.txt");
  await writeFile(join(outputRoot, "report.json"), originalReport);
  await writeFile(branchPath, "original branch");
  const network = vi.spyOn(globalThis, "fetch");
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(runPiCompactionReal({ configRoot: root, outputRoot })).resolves.toMatchObject({ status: "rejected", results: [] });
  }
  expect(await readFile(join(outputRoot, "report.json"), "utf8")).toBe(originalReport);
  expect(await readFile(branchPath, "utf8")).toBe("original branch");
  const rejected = (await readdir(outputRoot)).filter((name) => /^rejected-.*\.json$/.test(name));
  expect(rejected).toHaveLength(2);
  for (const name of rejected) expect(JSON.parse(await readFile(join(outputRoot, name), "utf8")).status).toBe("rejected");
  expect(network).not.toHaveBeenCalled();
  const storage = await StorageManager.init(join(outputRoot, "audit"));
  try {
    const rows = storage.db.prepare("select session_id, payload_json from trace_events where type = 'error.occurred'").all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(2);
    expect(rows.every((row) => String(row.payload_json).includes("output_root_exists"))).toBe(true);
  } finally { storage.db.close(); }
});

it("审计初始化失败也返回 failed 报告", async () => {
  root = await mkdtemp(join(tmpdir(), "figo-real-audit-failure-"));
  const outputRoot = join(root, "evidence");
  vi.spyOn(StorageManager, "init").mockRejectedValueOnce(new Error("审计初始化不可用"));
  await expect(runPiCompactionReal({ configRoot: root, outputRoot })).resolves.toMatchObject({ status: "failed" });
  expect(JSON.parse(await readFile(join(outputRoot, "report.json"), "utf8")).status).toBe("failed");
});

it("验收准备失败时写 failed 而不是遗留 running，并将错误写入 SQLite", async () => {
  const outputRoot = await configuredFixture(false);
  const network = vi.spyOn(globalThis, "fetch");
  const result = await runPiCompactionReal({ configRoot: root, outputRoot });
  expect(result.status).toBe("failed");
  expect(result.errors.join("\n")).toContain("不足 100000 字符");
  expect(network).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(outputRoot, "report.json"), "utf8")).status).toBe("failed");
  const storage = await StorageManager.init(join(outputRoot, "audit"));
  try { expect(storage.db.prepare("select count(*) as n from trace_events where type = 'error.occurred'").get()).toMatchObject({ n: 1 }); }
  finally { storage.db.close(); }
});

it("受控 Provider 贯通三模型全部分支，来源快照一致且未知窗口不获完整放行", async () => {
  const outputRoot = await configuredFixture(true);
  const originalConfig = await readFile(join(root, "figo-agent.config.json"), "utf8");
  let call = 0;
  const marker = "ACCEPTANCE-SUMMARY-CHECKPOINT";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const body = JSON.parse(String(init?.body));
    let message: unknown;
    let finish = "stop";
    if (!body.tools) message = { content: `## Goal\n${marker}\nreserveTokens=16384，keepRecentTokens=20000。` };
    else if (body.messages.at(-1)?.role === "tool") message = { content: "公式是 contextTokens > contextWindow - reserveTokens。16384、20000。Task 隔离，SQLite 保留来源；真实质量尚未验证。" };
    else if (String(body.messages.at(-1)?.content).includes("请先调用 read_file")) {
      message = { content: null, tool_calls: [{ id: `read_${++call}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/context/compaction-policy.ts" }) } }] };
      finish = "tool_calls";
    } else message = { content: "已审查真实源码调用链。默认16384与20000，后续工具核验。" };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }), { status: 200 });
  });
  const report = await runPiCompactionReal({ configRoot: root, outputRoot });
  const diagnostics = report.results.map((row) => ({ provider: row.providerId, scenario: row.scenario, status: row.result,
    manual: row.manualResult, passed: row.followupFactsAndToolsPassed,
    decisions: (row.evidence as { decisions: Array<{ type: string; payload_json: string }> }).decisions.map((event) => ({ type: event.type, ...JSON.parse(event.payload_json) })) }));
  expect(report.errors, JSON.stringify({ errors: report.errors, diagnostics })).toEqual([]);
  expect(report.status).toBe("partial");
  expect(report.results).toHaveLength(12);
  for (const providerId of ["a", "b", "c"]) {
    const results = report.results.filter((row) => row.providerId === providerId);
    const prefixStorage = await StorageManager.init(join(outputRoot, providerId, "natural"));
    try {
      const inputs = prefixStorage.db.prepare("select input from turns order by rowid").all() as Array<{ input: string }>;
      expect(inputs.length).toBeGreaterThan(1);
      expect(inputs.every(({ input }) => input.includes("不超过100字") && input.includes("资料收集阶段"))).toBe(true);
    } finally { prefixStorage.db.close(); }
    const prefixRequestIds = (results[0].evidence as { captures: Array<{ request_id: string }> }).captures.map((capture) => capture.request_id);
    expect((results[0].prefixTurnIds as string[]).length).toBeGreaterThan(1);
    for (const row of results) expect((row.evidence as { captures: Array<{ request_id: string }> }).captures.slice(0, prefixRequestIds.length).map((capture) => capture.request_id)).toEqual(prefixRequestIds);
    for (const row of results.filter((row) => row.scenario !== "natural-default")) {
      expect(row.followupFactsAndToolsPassed).toBe(true);
      const storage = await StorageManager.init(dirname(dirname(row.database as string)));
      try {
        const captures = storage.db.prepare("select request_body_json from llm_http_captures where turn_id = ? and purpose = 'turn' order by rowid").all(row.turnId as string) as Array<{ request_body_json: string }>;
        expect(captures.some((capture) => JSON.parse(capture.request_body_json).messages.some((message: { content: string }) => message.content?.includes(marker)))).toBe(row.scenario !== "off");
      } finally { storage.db.close(); }
    }
    await expect(stat(join(outputRoot, providerId, "private-config"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await readFile(join(root, "figo-agent.config.json"), "utf8")).toBe(originalConfig);
}, 30000);

it("按统一JSON执行三次配对、显式窗口且每次都复制同一份历史，不混计共同前缀", async () => {
  const outputRoot = await configuredFixture(true, { pairRepetitions: 3, scenarios: ["off", "auto-test-window"] });
  const originalConfig = await readFile(join(root, "figo-agent.config.json"), "utf8");
  let call = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const body = JSON.parse(String(init?.body));
    const prefix = String(body.messages.at(-1)?.content);
    const tool = body.messages.at(-1)?.role === "tool";
    const invokes = body.tools && !tool && prefix.includes("请先调用 read_file");
    const content = !body.tools ? "## Goal\n配对摘要。默认16384、20000，Task隔离与SQLite来源。"
      : tool ? "contextTokens > contextWindow - reserveTokens；16384、20000；Task隔离，SQLite原文保留。"
        : invokes ? "我先读取文件核验。" : "已收到源码资料。";
    return new Response(JSON.stringify({ choices: [{ message: { content, ...(invokes ? { tool_calls: [{ id: `paired_${++call}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/context/compaction-policy.ts" }) } }] } : {}) }, finish_reason: invokes ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4), completion_tokens: 30,
        total_tokens: Math.ceil(JSON.stringify(body.messages).length / 4) + 30 } }), { status: 200 });
  });
  const report = await runPiCompactionReal({ configRoot: root, outputRoot });
  expect(report.errors).toEqual([]);
  expect(report.status).toBe("partial");
  expect(report.results).toHaveLength(21);
  const branches = report.results.filter((row) => row.scenario !== "natural-default");
  expect(branches).toHaveLength(18);
  for (const providerId of ["a", "b", "c"]) {
    const providerRows = branches.filter((row) => row.providerId === providerId);
    expect(providerRows.map((row) => `${row.repetition}/${row.scenario}`)).toEqual([
      "1/off", "1/auto-test-window", "2/auto-test-window", "2/off", "3/off", "3/auto-test-window"
    ]);
    expect(new Set(providerRows.map((row) => row.database)).size).toBe(6);
    for (const row of providerRows) {
      expect(row.followupFactsAndToolsPassed).toBe(true);
      expect(row.wallClockMs).toEqual(expect.any(Number));
      const metrics = row.metrics as { requestCount: number; summaryRequestCount: number; prefixRequestIdsMatch: boolean;
        completedToolCount: number; protocolRepairCount: number; summaryChecks: Array<{ summaryInNextRequest: boolean; retainedPrefixUnchanged: boolean }> };
      expect(metrics.prefixRequestIdsMatch).toBe(true);
      expect(metrics.protocolRepairCount).toBe(0);
      expect(metrics.completedToolCount).toBe(1);
      expect(metrics.requestCount).toBe(row.scenario === "off" ? 2 : 3);
      expect(metrics.summaryRequestCount).toBe(row.scenario === "off" ? 0 : 1);
      if (row.scenario !== "off") {
        expect(row.testWindow).toBe(49152);
        expect(metrics.summaryChecks).toHaveLength(1);
        expect(metrics.summaryChecks[0]).toMatchObject({ summaryInNextRequest: true, retainedPrefixUnchanged: true });
      }
      const storage = await StorageManager.init(dirname(dirname(row.database as string)));
      try {
        expect(storage.db.prepare("select count(*) as n from trace_events where source = 'PiCompactionAcceptance' and type = 'artifact.created'").get()).toMatchObject({ n: 1 });
      } finally { storage.db.close(); }
    }
  }
  expect(await readFile(join(root, "figo-agent.config.json"), "utf8")).toBe(originalConfig);
}, 30000);

it("正常测试窗口不得小于预留量加近期保留量，非法配置在发请求前失败", async () => {
  const outputRoot = await configuredFixture(true, { testContextWindow: 35440 });
  const network = vi.spyOn(globalThis, "fetch");
  const report = await runPiCompactionReal({ configRoot: root, outputRoot });
  expect(report.status).toBe("failed");
  expect(report.errors.join("\n")).toContain("reserveTokens + keepRecentTokens");
  expect(network).not.toHaveBeenCalled();
});

it("模型失败也索引其原始抓包与数据库，不能只留下成功分支", async () => {
  const outputRoot = await configuredFixture(true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 }));
  const report = await runPiCompactionReal({ configRoot: root, outputRoot });
  expect(report.status).toBe("failed");
  expect(report.results).toHaveLength(3);
  for (const row of report.results) {
    expect(row.scenario).toBe("natural-default");
    expect(row.result).toBe("failed");
    expect(typeof row.database).toBe("string");
    const captures = (row.evidence as { captures: Array<{ response_status: number }> }).captures;
    expect(captures).toHaveLength(1);
    expect(captures[0].response_status).toBe(401);
    await expect(stat(join(outputRoot, String(row.providerId), "private-config"))).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 30000);
