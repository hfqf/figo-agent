import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentKernel } from "../src/kernel/agent-kernel.js";
import { TurnManager } from "../src/kernel/turn-manager.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config/runtime-config.js";
import { readPiCompactionSettings } from "../src/config/pi-compaction-settings.js";
import { AgentLoop } from "../src/loop/agent-loop.js";
import { CompactionService } from "../src/context/compaction-service.js";
import { CompactionStore } from "../src/context/compaction-store.js";
import { TaskHistoryReader } from "../src/context/task-history-reader.js";
import { ContextMessageStore } from "../src/context/context-message-store.js";
import { createBuiltinPluginHost } from "../src/plugin/builtin-plugins.js";
import type { LLMProvider, TurnResult } from "../src/contracts/types.js";
import { StorageManager } from "../src/storage/storage-manager.js";
import { TraceRecorder } from "../src/trace/trace-recorder.js";
import { nowShanghaiTime } from "../src/utils/clock.js";
import { readPiAcceptanceSettings, type AcceptanceScenario } from "./pi-compaction-settings.js";
import { measurePiCompactionBranch, type PiCompactionBranchMeasurements } from "./pi-compaction-measurements.js";

interface Options { configRoot: string; outputRoot: string; timeoutMs?: number }
type Row = Record<string, unknown>;
const followup = "请先调用 read_file 读取 src/context/compaction-policy.ts，核对之前的源码审查。明确回答自动压缩公式、reserveTokens 和 keepRecentTokens 默认值、Task 与 SQLite 来源边界；列出尚未验证的事项。不要修改文件。";

export function evaluatePiCompactionFollowup(input: {
  scenario: AcceptanceScenario;
  resultStatus: TurnResult["status"];
  message: string;
  requestedFileReadPassed: boolean;
  metrics: PiCompactionBranchMeasurements;
  decisions: Row[];
}) {
  // 保留换行边界，避免把下一行 Markdown 列表当成公式后续运算。
  const formulaText = input.message.replace(/[_`*()（）]/g, "").replace(/[−–—﹣－]/g, "-").replace(/[ \t]*([.><=-])[ \t]*/g, "$1");
  const facts = formulaText.replace(/[\s,]/g, "");
  const qualified = "(?:[A-Za-z_$][A-Za-z0-9_$]*\\.)*";
  const strictFormula = new RegExp(`(?:^|[^A-Za-z0-9_$.])${qualified}contextTokens>${qualified}contextWindow-${qualified}reserveTokens(?![ \\t]*[A-Za-z0-9_$.+*/=<>-])`);
  const defaults = readPiCompactionSettings(undefined);
  const factChecks = {
    reserveTokens: facts.includes(String(defaults.reserveTokens)),
    keepRecentTokens: facts.includes(String(defaults.keepRecentTokens)),
    formula: strictFormula.test(formulaText),
    taskAndStorage: /Task|task|任务/.test(facts) && /SQLite|sqlite/.test(facts)
  };
  const followupFactsAndToolsPassed = input.resultStatus === "completed" && input.requestedFileReadPassed && Object.values(factChecks).every(Boolean);
  const { metrics } = input;
  const projectionPassed = metrics.prefixRequestIdsMatch && (input.scenario === "off" || metrics.summaryChecks.length > 0 &&
    metrics.summaryChecks.every((check) => check.summaryInNextRequest && (check.retainedPrefixMessages === 0 || check.retainedPrefixUnchanged)));
  const requiredMode = input.scenario === "manual" ? "manual" : "auto";
  const triggerModePassed = input.scenario === "off" ? metrics.summaryChecks.length === 0 : input.decisions.some((decision) => {
    if (decision.type !== "compaction.completed" || typeof decision.payload_json !== "string") return false;
    try {
      const payload = JSON.parse(decision.payload_json);
      return payload?.mode === requiredMode && metrics.summaryChecks.some((check) => check.entryId === payload.checkpointId);
    } catch { return false; }
  });
  return { factChecks, followupFactsAndToolsPassed, projectionPassed, triggerModePassed,
    passed: followupFactsAndToolsPassed && projectionPassed && triggerModePassed };
}

export async function runPiCompactionReal(options: Options) {
  const configRoot = resolve(options.configRoot);
  const outputRoot = resolve(options.outputRoot);
  const attemptId = `acceptance-${randomUUID()}`;
  let reportPath = join(outputRoot, "report.json");
  let audit: StorageManager | undefined;
  let auditTrace: TraceRecorder | undefined;
  const preflight: Array<{ id: string; model: string; baseUrl: string; contextWindow: number | null;
    maxTokens: number | null; metadataSource: string | null; credentialConfigured: boolean }> = [];
  const report: { startedAt: string; finishedAt?: string; status: string; functionalStatus?: string; capacityStatus?: string; measurementStatus: string;
    preflight: typeof preflight; settings: Row; results: Row[]; errors: string[] } = {
    startedAt: nowShanghaiTime(), status: "running", measurementStatus: "not_run", preflight,
    settings: { upstreamCommit: "6a1f799b675c8cb98320b71ff7ee44f160fe8d66" }, results: [], errors: []
  };
  try {
    await mkdir(dirname(outputRoot), { recursive: true });
    let outputExists = false;
    try { await mkdir(outputRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      outputExists = true;
      reportPath = join(outputRoot, `rejected-${attemptId}.json`);
    }
    audit = await StorageManager.init(join(outputRoot, "audit"));
    audit.db.prepare("insert into sessions (id,cwd,status,started_at) values (?,?,?,?)").run(attemptId, outputRoot, "active", nowShanghaiTime());
    auditTrace = new TraceRecorder(audit);
    if (outputExists) {
      report.status = "rejected";
      report.errors.push("输出目录已存在，拒绝继续实验；原报告和分支保持不变。");
      await auditTrace.record({ sessionId: attemptId, type: "error.occurred", source: "PiCompactionAcceptance", payload: {
        reason: "output_root_exists", reportPath } });
      return report;
    }
    const config = await loadRuntimeConfig(configRoot);
    const models = config.llm.filter((model) => model.enabled);
    preflight.push(...models.map(({ id, model, baseUrl, contextWindow, maxTokens, metadataSource, apiKey }) => ({
      id, model, baseUrl, contextWindow: contextWindow ?? null, maxTokens: maxTokens ?? null,
      metadataSource: metadataSource ?? null, credentialConfigured: Boolean(apiKey.trim())
    })));
    Object.assign(report.settings, { reserveTokens: config.context.compaction.reserveTokens, keepRecentTokens: config.context.compaction.keepRecentTokens });
    if (models.length !== 3 || preflight.some((model) => !model.credentialConfigured)) {
      report.status = "blocked";
      report.errors.push("必须配置三个启用模型的非空 API Key；未发送占位模型请求。");
      await auditTrace.record({ sessionId: attemptId, type: "error.occurred", source: "PiCompactionAcceptance", payload: {
        reason: "credentials_missing", providers: preflight.map(({ credentialConfigured, ...entry }) => ({ ...entry, readyForRemoteCall: credentialConfigured }))
      } });
      return report;
    }
    const settings = await readPiAcceptanceSettings(configRoot, config, options.timeoutMs);
    Object.assign(report.settings, settings);
    const sourcePaths: string[] = [];
    let source = "";
    for (const directory of ["context", "loop", "config"]) {
      for (const name of (await readdir(join(configRoot, "src", directory))).sort()) {
        if (!name.endsWith(".ts")) continue;
        const relative = `src/${directory}/${name}`;
        sourcePaths.push(relative);
        source += `\n\n# ${relative}\n${await readFile(join(configRoot, relative), "utf8")}`;
      }
    }
    if (source.length < settings.sourceSnapshotMinChars) throw new Error(`真实源码快照不足 ${settings.sourceSnapshotMinChars} 字符，不能把短历史报告成长期任务验收。`);
    report.settings.sourceSnapshotChars = source.length;
    for (const model of models) {
      const modelRoot = join(outputRoot, model.id);
      const naturalRoot = join(modelRoot, "natural");
      await mkdir(naturalRoot, { recursive: true });
      for (const path of sourcePaths) {
        await mkdir(dirname(join(naturalRoot, path)), { recursive: true });
        await cp(join(configRoot, path), join(naturalRoot, path));
      }
      const runConfig: RuntimeConfig = { ...structuredClone(config), activeModelId: model.id,
        context: { ...structuredClone(config.context), includeMemory: false } };
      const privateConfig = join(modelRoot, "private-config");
      await mkdir(privateConfig, { recursive: true });
      await writeFile(join(privateConfig, "figo-agent.config.json"), JSON.stringify(runConfig), { mode: 0o600 });
      let kernel: AgentKernel | undefined;
      let sessionId = "";
      let taskId = "";
      let prefixRequestIds: string[] = [];
      let prefixMessages: ReturnType<TaskHistoryReader["messages"]> = [];
      try {
        kernel = await AgentKernel.start({ workspaceRoot: naturalRoot, configRoot: privateConfig });
        const task = kernel.storage.db.prepare("select id from tasks where session_id = ?").get(kernel.session.id) as { id: string };
        sessionId = kernel.session.id;
        taskId = task.id;
        const chunkChars = settings.sourceChunkMaxChars;
        const prefixTurnIds: string[] = [];
        for (let offset = 0; offset < source.length; offset += chunkChars) {
          const turn = new TurnManager(kernel.storage).create(sessionId, taskId,
            `请继续同一个上下文压缩源码审查任务。当前是资料收集阶段，这是按文件名排序源码快照的第${Math.floor(offset / chunkChars) + 1}段，字符范围${offset}-${Math.min(offset + chunkChars, source.length)}。本轮只用不超过100字确认收到，不逐段展开报告，不调用工具、不修改文件。后续统一结合全部片段核对调用链、压缩时机、安全切点、默认参数、来源留痕与失败恢复，并执行工具核验。\n${source.slice(offset, offset + chunkChars)}`);
          prefixTurnIds.push(turn.id);
          const result = await execute(kernel.storage, turn.id, () => kernel!.runPreparedTurn(turn, undefined, { providerId: model.id, modelId: model.model }, AbortSignal.timeout(settings.timeoutMs)));
          if (result.status !== "completed") throw new Error(`${model.id} 原始长任务失败：${result.error?.message ?? result.message}`);
        }
        prefixRequestIds = (kernel.storage.db.prepare("select request_id from llm_http_captures order by rowid").all() as Array<{ request_id: string }>).map((row) => row.request_id);
        prefixMessages = new TaskHistoryReader(kernel.storage).messages(taskId);
        report.results.push({ providerId: model.id, scenario: "natural-default", actualWindow: model.contextWindow ?? null,
          modelWindowConfigured: model.contextWindow !== undefined, result: "completed", prefixTurnIds,
          evidence: collect(kernel.storage), database: kernel.storage.paths.databasePath });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report.errors.push(reason);
        report.results.push({ providerId: model.id, scenario: "natural-default", actualWindow: model.contextWindow ?? null,
          result: "failed", reason, database: kernel?.storage.paths.databasePath ?? null,
          ...(kernel ? { evidence: collect(kernel.storage) } : {}) });
        continue;
      } finally {
        if (kernel?.storage.db.isOpen) kernel.storage.db.close();
        await rm(privateConfig, { recursive: true, force: true });
      }
      // 每次配对复制同一份历史；交替执行顺序，不让某分支永远先请求远程端点。
      for (let repetition = 1; repetition <= settings.pairRepetitions; repetition++) {
        const scenarios = repetition % 2 === 0 ? [...settings.scenarios].reverse() : settings.scenarios;
        for (const scenario of scenarios) {
          const branchRoot = join(modelRoot, `pair-${repetition}`, scenario);
          await cp(naturalRoot, branchRoot, { recursive: true });
          const storage = await StorageManager.init(branchRoot);
          const trace = new TraceRecorder(storage);
          const testConfig = structuredClone(runConfig);
          if (scenario === "off") testConfig.context.compaction.enabled = false;
          if (scenario === "auto-test-window" || scenario === "stress-test-window") {
            // 只覆盖隔离测试窗口，不伪造或回写真实端点容量。
            testConfig.llm.find((item) => item.id === model.id)!.contextWindow = scenario === "auto-test-window"
              ? settings.testContextWindow : settings.stressContextWindow;
          }
          const started = Date.now();
          const signal = AbortSignal.timeout(settings.timeoutMs);
          let turnId = "";
          let manualResult: string | undefined;
          try {
            const host = createBuiltinPluginHost(storage, trace, sessionId, testConfig);
            await host.setupAll({ sessionId });
            const llm = host.requireCapability<LLMProvider>("llmProvider", model.id);
            const compaction = new CompactionService(new TaskHistoryReader(storage), new CompactionStore(storage), llm, trace, model.model, testConfig.context.compaction, new ContextMessageStore(storage));
            const selected = testConfig.llm.find((item) => item.id === model.id)!;
            const loop = new AgentLoop(host, trace, { llmId: model.id, model: model.model, compaction,
              contextConfig: testConfig.context, behavior: testConfig.agent,
              resolveModelConfig: () => selected });
            const compactResult = scenario === "manual" ? await compaction.compact({ sessionId, taskId, mode: "manual", instructions: "保留压缩公式、默认值、安全边界和未验证事项。", signal }, { llm, model: model.model, providerId: model.id, contextWindow: selected.contextWindow, maxTokens: selected.maxTokens, maxTokensField: selected.maxTokensField }) : undefined;
            manualResult = compactResult?.status;
            if (compactResult && compactResult.status !== "completed") throw new Error(`手动摘要未完成：${compactResult.reason}`);
            const turn = new TurnManager(storage).create(sessionId, taskId, followup);
            turnId = turn.id;
            const followupStarted = Date.now();
            const result = await execute(storage, turn.id, () => loop.runTurn({ sessionId, taskId, turnId: turn.id, input: followup, workspaceRoot: branchRoot, signal }));
            const followupElapsedMs = Date.now() - followupStarted;
            const wallClockMs = Date.now() - started;
            const requestedFileReadPassed = storage.db.prepare("select input_json from tool_calls where turn_id = ? and tool_name = 'read_file' and status = 'completed'")
              .all(turn.id).some((row) => {
                try { return JSON.parse(String(row.input_json))?.path === "src/context/compaction-policy.ts"; }
                catch { return false; }
              });
            const metrics = measurePiCompactionBranch({ storage, taskId, turnId, prefixRequestIds, prefixMessages });
            const evidence = collect(storage);
            const evaluation = evaluatePiCompactionFollowup({ scenario, resultStatus: result.status, message: result.message,
              requestedFileReadPassed, metrics, decisions: evidence.decisions });
            const branch = { providerId: model.id, repetition, scenario, actualWindow: model.contextWindow ?? null,
              testWindow: scenario === "auto-test-window" || scenario === "stress-test-window" ? selected.contextWindow : null,
              manualResult, taskId, turnId, result: result.status, requestedFileReadPassed, ...evaluation,
              wallClockMs, followupElapsedMs, database: storage.paths.databasePath, metrics };
            await trace.record({ sessionId, taskId, turnId, type: "artifact.created", source: "PiCompactionAcceptance", payload: branch });
            report.results.push({ ...branch, evidence });
            if (!evaluation.passed) report.errors.push(`${model.id}/pair-${repetition}/${scenario} 未通过后续任务、投影或触发模式检查`);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            report.errors.push(`${model.id}/pair-${repetition}/${scenario}: ${reason}`);
            const branch = { providerId: model.id, repetition, scenario, result: "failed", reason, taskId, turnId,
              manualResult, wallClockMs: Date.now() - started, database: storage.paths.databasePath,
              metrics: measurePiCompactionBranch({ storage, taskId, turnId, prefixRequestIds, prefixMessages }) };
            await trace.record({ sessionId, taskId, ...(turnId ? { turnId } : {}), type: "error.occurred", source: "PiCompactionAcceptance", payload: branch });
            report.results.push({ ...branch, evidence: collect(storage) });
          } finally { storage.db.close(); }
        }
      }
    }
    report.functionalStatus = report.errors.length ? "failed" : "passed";
    report.capacityStatus = preflight.some((model) => model.contextWindow === null) ? "endpoint_window_unknown" : "declared_windows_only";
    const evidence = report.results.map((row) => row.evidence as ReturnType<typeof collect> | undefined).filter((row) => row !== undefined);
    const hasCaptures = evidence.some((row) => row.captures.length > 0);
    report.measurementStatus = !hasCaptures ? "not_run" : evidence.some((row) => row.captures.some((capture) => {
      const usage = row.usage.find((item) => item.request_id === capture.request_id);
      return !usage || usage.status !== "complete" || ![usage.prompt_tokens, usage.completion_tokens].every((value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
    })) ? "incomplete" : "complete";
    report.status = report.errors.length ? "failed" : report.capacityStatus === "endpoint_window_unknown" || report.measurementStatus !== "complete" ? "partial" : "passed";
    await auditTrace.record({ sessionId: attemptId, type: "artifact.created", source: "PiCompactionAcceptance", payload: {
      status: report.status, functionalStatus: report.functionalStatus, capacityStatus: report.capacityStatus, measurementStatus: report.measurementStatus,
      scenarios: report.results.length, errors: report.errors } });
    return report;
  } catch (error) {
    report.status = "failed";
    report.functionalStatus = "failed";
    const reason = error instanceof SyntaxError ? "配置 JSON 解析失败；为保护敏感字段，不记录原始解析错误。" : error instanceof Error ? error.message : String(error);
    report.errors.push(reason);
    await auditTrace?.record({ sessionId: attemptId, type: "error.occurred", source: "PiCompactionAcceptance", payload: { reason: "acceptance_failed", message: reason } });
    return report;
  } finally {
    report.finishedAt = nowShanghaiTime();
    try { await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx" }); }
    finally { if (audit?.db.isOpen) audit.db.close(); }
  }
}

async function execute(storage: StorageManager, turnId: string, run: () => Promise<TurnResult>) {
  const turns = new TurnManager(storage);
  turns.markProcessing(turnId);
  const result = await run();
  if (result.status === "completed") turns.complete(turnId); else turns.fail(turnId);
  storage.db.prepare("update turns set output = ? where id = ?").run(result.message, turnId);
  return result;
}

function collect(storage: StorageManager) {
  return {
    captures: storage.db.prepare("select request_id, purpose, provider, model, response_status, duration_ms, length(request_body_json) as request_chars, length(response_body_json) as response_chars from llm_http_captures order by rowid").all(),
    usage: storage.db.prepare("select request_id, purpose, prompt_tokens, completion_tokens, total_tokens, status from token_usage order by rowid").all(),
    decisions: storage.db.prepare("select type, payload_json, created_at from trace_events where type like 'compaction.%' order by rowid").all(),
    entries: storage.db.prepare("select id, seq, base_entry_id, first_kept_source_ref, source_refs_json, tokens_before, request_id, details_json from context_compactions order by seq").all()
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputRoot = resolve(".figo-agent", "acceptance", `pi-${Date.now()}`);
  const report = await runPiCompactionReal({ configRoot: resolve("code"), outputRoot });
  console.log(JSON.stringify({ status: report.status, outputRoot, errors: report.errors }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}
