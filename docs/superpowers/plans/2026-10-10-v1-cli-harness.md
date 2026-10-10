# Figo Agent V1 CLI Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the V1 local CLI agent harness with Session/Turn, SQLite state, TraceEvent, static plugins, read-only tools, project-understanding skill, and Markdown artifacts.

**Architecture:** The implementation follows the documented small-kernel architecture: CLI calls AgentKernel, AgentKernel manages Session/Turn and creates AgentLoop, AgentLoop uses PluginHost capabilities. SQLite is the state source, JSONL is the audit stream, and Markdown is the human-readable artifact layer.

**Tech Stack:** TypeScript, Node.js 22, npm, Vitest, tsx, better-sqlite3, built-in fetch, MiniMax OpenAI-compatible Chat Completions, Markdown files.

## Global Constraints

- Documentation and user-facing CLI output use Chinese.
- V1 is command-line REPL first.
- V1 does not implement Goal.
- V1 does not implement `apply_patch`, `run_command`, Git, browser, external API tools, Verifier, dynamic plugin loading, TokenUsage persistence, or automatic Memory writes.
- V1 uses SQLite as state source, JSONL as audit stream, Markdown as reading artifact.
- V1 tools are read-only: `list_files`, `read_file`, `search_text`.
- V1 has one built-in skill: `project-understanding-skill`.
- Every core action writes structured TraceEvent.
- CLI calls AgentKernel only.
- AgentLoop gets capabilities through PluginHost / Registry only.
- Policy allows only `list_files`, `read_file`, `search_text`.
- LLM tests use MiniMax through environment variables only: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`.
- API keys are never written to source files, docs, TraceEvent payloads, SQLite, JSONL, Markdown artifacts, or test snapshots.

---

## Target File Structure

## Module Implementation Plan Index

Each module owns its implementation and acceptance gates:

| Module | Implementation | Acceptance |
| --- | --- | --- |
| CLI / REPL | [IMPLEMENTATION.md](../../agent/modules/cli-repl/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/cli-repl/ACCEPTANCE.md) |
| AgentKernel | [IMPLEMENTATION.md](../../agent/modules/agent-kernel/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/agent-kernel/ACCEPTANCE.md) |
| AgentLoop | [IMPLEMENTATION.md](../../agent/modules/agent-loop/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/agent-loop/ACCEPTANCE.md) |
| PluginHost | [IMPLEMENTATION.md](../../agent/modules/plugin-host/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/plugin-host/ACCEPTANCE.md) |
| Storage | [IMPLEMENTATION.md](../../agent/modules/storage/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/storage/ACCEPTANCE.md) |
| Trace | [IMPLEMENTATION.md](../../agent/modules/trace/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/trace/ACCEPTANCE.md) |
| LLM / Policy | [IMPLEMENTATION.md](../../agent/modules/llm-policy/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/llm-policy/ACCEPTANCE.md) |
| Tool | [IMPLEMENTATION.md](../../agent/modules/tool/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/tool/ACCEPTANCE.md) |
| Context | [IMPLEMENTATION.md](../../agent/modules/context/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/context/ACCEPTANCE.md) |
| Memory | [IMPLEMENTATION.md](../../agent/modules/memory/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/memory/ACCEPTANCE.md) |
| Skill | [IMPLEMENTATION.md](../../agent/modules/skill/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/skill/ACCEPTANCE.md) |
| Reporter | [IMPLEMENTATION.md](../../agent/modules/reporter/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/reporter/ACCEPTANCE.md) |
| TokenUsage | [IMPLEMENTATION.md](../../agent/modules/token-usage/IMPLEMENTATION.md) | [ACCEPTANCE.md](../../agent/modules/token-usage/ACCEPTANCE.md) |

Gate rule: A module is not releasable until every command and condition in its `ACCEPTANCE.md` passes.

Create:

```text
package.json
tsconfig.json
vitest.config.ts
.env.example
src/cli/main.ts
src/cli/input-router.ts
src/cli/renderer.ts
src/kernel/agent-kernel.ts
src/kernel/session-manager.ts
src/kernel/turn-manager.ts
src/loop/agent-loop.ts
src/contracts/types.ts
src/storage/storage-manager.ts
src/storage/schema.ts
src/trace/trace-recorder.ts
src/plugin/plugin-host.ts
src/plugin/builtin-plugins.ts
src/policy/read-only-policy.ts
src/llm/openai-compatible-provider.ts
src/tools/tool-registry.ts
src/tools/read-only-tools.ts
src/context/context-builder.ts
src/memory/sqlite-memory-store.ts
src/skill/project-understanding-skill.ts
src/reporter/markdown-reporter.ts
src/utils/id.ts
src/utils/clock.ts
src/utils/path.ts
tests/cli/input-router.test.ts
tests/storage/storage-manager.test.ts
tests/trace/trace-recorder.test.ts
tests/plugin/plugin-host.test.ts
tests/policy/read-only-policy.test.ts
tests/tools/read-only-tools.test.ts
tests/context/context-builder.test.ts
tests/reporter/markdown-reporter.test.ts
tests/kernel/agent-kernel.test.ts
tests/e2e/project-understanding.test.ts
```

Modify:

```text
readme.md
AGENTS.MD
```

Responsibility map:

- `src/contracts/types.ts`: shared interfaces and data types.
- `src/storage/*`: `.figo-agent/`, SQLite schema, artifact paths, atomic writes.
- `src/trace/*`: TraceEvent normalization, SQLite insert, JSONL append.
- `src/plugin/*`: static plugin registration and capability lookup.
- `src/policy/*`: V1 read-only permission boundary.
- `src/tools/*`: read-only tool implementations and ToolRegistry.
- `src/context/*`: ContextPack construction from current turn, project files, memory.
- `src/memory/*`: SQLite-backed read path for MemoryRecord.
- `src/skill/*`: project-understanding-skill orchestration.
- `src/reporter/*`: `context.md` and `report.md`.
- `src/kernel/*`: startup assembly and Session/Turn lifecycle.
- `src/cli/*`: REPL input, command routing, rendering.

---

### Task 1: Project Scaffold And Test Harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `src/utils/id.ts`
- Create: `src/utils/clock.ts`
- Test: `tests/utils-smoke.test.ts`

**Interfaces:**
- Produces: `createId(prefix: string): string`
- Produces: `nowIso(): string`

- [ ] **Step 1: Create package scripts and dependencies**

Create `package.json`:

```json
{
  "name": "figo-agent",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": {
    "figo-agent": "./dist/cli/main.js"
  },
  "scripts": {
    "dev": "tsx src/cli/main.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.9.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000
  }
});
```

- [ ] **Step 4: Add ID and clock utilities**

Create `.env.example`:

```bash
MINIMAX_API_KEY=
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M2.7
```

Rule: `.env.example` stores variable names and public defaults only. It does not store real API keys.

- [ ] **Step 5: Add ID and clock utilities**

Create `src/utils/id.ts`:

```ts
import { randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
```

Create `src/utils/clock.ts`:

```ts
export function nowIso(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 6: Write smoke test**

Create `tests/utils-smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createId } from "../src/utils/id.js";
import { nowIso } from "../src/utils/clock.js";

describe("utils", () => {
  it("creates prefixed ids", () => {
    expect(createId("ses")).toMatch(/^ses_/);
  });

  it("creates ISO timestamps", () => {
    expect(new Date(nowIso()).toString()).not.toBe("Invalid Date");
  });
});
```

- [ ] **Step 7: Install and verify**

Run:

```bash
npm install
npm test
npm run typecheck
```

Expected:

```text
1 test file passes
TypeScript exits with code 0
```

---

### Task 2: Core Contracts

**Files:**
- Create: `src/contracts/types.ts`
- Test: `tests/contracts-types.test.ts`

**Interfaces:**
- Produces: all shared interfaces consumed by later tasks.

- [ ] **Step 1: Write type smoke test**

Create `tests/contracts-types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TraceEvent, Tool, ToolResult } from "../src/contracts/types.js";

describe("contracts", () => {
  it("supports trace and tool contracts", async () => {
    const event: TraceEvent = {
      id: "trc_1",
      sessionId: "ses_1",
      turnId: "turn_1",
      type: "turn.received",
      source: "AgentKernel",
      payload: {},
      createdAt: "2026-10-10T00:00:00.000Z"
    };

    const tool: Tool<{ path: string }, { ok: boolean }> = {
      name: "read_file",
      description: "read",
      execute: async (): Promise<ToolResult<{ ok: boolean }>> => ({
        status: "completed",
        output: { ok: true }
      })
    };

    await expect(tool.execute({ path: "readme.md" }, {} as never)).resolves.toEqual({
      status: "completed",
      output: { ok: true }
    });
    expect(event.type).toBe("turn.received");
  });
});
```

- [ ] **Step 2: Create shared contracts**

Create `src/contracts/types.ts`:

```ts
export type SessionStatus = "active" | "ended" | "failed";
export type TurnStatus = "received" | "processing" | "completed" | "failed";

export interface Session {
  id: string;
  cwd: string;
  status: SessionStatus;
  startedAt: string;
  endedAt?: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  input: string;
  status: TurnStatus;
  createdAt: string;
  completedAt?: string;
}

export type TraceEventType =
  | "session.started"
  | "session.ended"
  | "session.failed"
  | "turn.received"
  | "turn.processing"
  | "turn.completed"
  | "turn.failed"
  | "context.build.started"
  | "context.item.candidate"
  | "context.item.included"
  | "context.item.excluded"
  | "context.build.completed"
  | "memory.search.started"
  | "memory.search.completed"
  | "plugin.registered"
  | "plugin.ready"
  | "plugin.failed"
  | "capability.registered"
  | "capability.lookup.failed"
  | "skill.activated"
  | "skill.skipped"
  | "skill.completed"
  | "skill.failed"
  | "tool.called"
  | "tool.completed"
  | "tool.failed"
  | "tool.denied"
  | "policy.evaluated"
  | "policy.denied"
  | "llm.called"
  | "llm.completed"
  | "llm.failed"
  | "artifact.created"
  | "error.occurred";

export interface TraceEvent {
  id: string;
  sessionId: string;
  turnId?: string;
  type: TraceEventType;
  source: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Artifact {
  id: string;
  sessionId: string;
  turnId?: string;
  type: "context" | "report" | "memory" | "trace";
  path: string;
  bytes: number;
  createdAt: string;
}

export interface ContextItem {
  id: string;
  sourceType: string;
  sourceRef: string;
  summary: string;
  content: string;
  estimatedTokens: number;
  included: boolean;
  reason: string;
}

export interface ContextPack {
  id: string;
  sessionId: string;
  turnId: string;
  items: ContextItem[];
  estimatedTokens: number;
  createdAt: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LLMRequest {
  id: string;
  sessionId: string;
  turnId: string;
  contextPackId: string;
  messages: LLMMessage[];
  model: string;
  estimatedInputTokens?: number;
}

export interface LLMResponse {
  id: string;
  requestId: string;
  content: string;
  model: string;
  finishReason: "stop" | "length" | "error";
  outputLength: number;
  durationMs: number;
}

export interface LLMProvider {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export type PolicyAction =
  | "tool.list_files"
  | "tool.read_file"
  | "tool.search_text"
  | "tool.write_file"
  | "tool.run_command"
  | "tool.git"
  | "tool.network"
  | "tool.browser";

export interface PolicyRequest {
  sessionId: string;
  turnId: string;
  action: PolicyAction;
  resource: string;
  metadata: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  code:
    | "allowed"
    | "tool_not_allowed"
    | "path_outside_workspace"
    | "read_limit_exceeded"
    | "result_limit_exceeded"
    | "action_not_supported";
}

export interface Policy {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
}

export interface ToolExecutionContext {
  sessionId: string;
  turnId: string;
  workspaceRoot: string;
}

export type ToolResult<TOutput = unknown> =
  | { status: "completed"; output: TOutput }
  | { status: "failed"; errorMessage: string; errorCode: string };

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}

export interface SkillRunResult {
  status: "completed" | "failed" | "skipped";
  message: string;
  artifacts: Artifact[];
}

export interface TurnResult {
  sessionId: string;
  turnId: string;
  status: "completed" | "failed";
  message: string;
  artifacts: Artifact[];
  error?: { code: string; message: string };
}
```

- [ ] **Step 3: Verify contracts**

Run:

```bash
npm test -- tests/contracts-types.test.ts
npm run typecheck
```

Expected:

```text
contracts-types.test.ts passes
TypeScript exits with code 0
```

---

### Task 3: Storage And SQLite Schema

**Files:**
- Create: `src/storage/schema.ts`
- Create: `src/storage/storage-manager.ts`
- Create: `src/utils/path.ts`
- Test: `tests/storage/storage-manager.test.ts`

**Interfaces:**
- Produces: `StorageManager.init()`
- Produces: `StorageManager.db`
- Produces: `StorageManager.writeArtifact(input)`
- Consumes: contracts from Task 2.

- [ ] **Step 1: Write storage test**

Create `tests/storage/storage-manager.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";

let workspace = "";

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("StorageManager", () => {
  it("initializes database and artifact directories", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);

    expect(storage.paths.agentRoot).toContain(".figo-agent");
    expect(storage.db.prepare("select name from sqlite_master where type='table' and name='sessions'").get()).toBeTruthy();
  });

  it("writes artifact files and metadata", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses_1", workspace, "active", "2026-10-10T00:00:00.000Z");

    const artifact = await storage.writeArtifact({
      id: "art_1",
      sessionId: "ses_1",
      type: "report",
      path: ".figo-agent/artifacts/sessions/ses_1/report.md",
      content: "# 报告"
    });

    expect(artifact.bytes).toBeGreaterThan(0);
    await expect(readFile(join(workspace, artifact.path), "utf8")).resolves.toContain("# 报告");
  });
});
```

- [ ] **Step 2: Add schema**

Create `src/storage/schema.ts` with V1 tables:

```ts
export const schemaSql = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_items (
  id TEXT PRIMARY KEY,
  context_pack_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  summary TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  included INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  skill_run_id TEXT,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS trace_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_session_created ON turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_session_created ON trace_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_turn_created ON trace_events(turn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_type_created ON trace_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_created ON artifacts(session_id, created_at);
`;
```

- [ ] **Step 3: Add path helper and storage manager**

Create `src/utils/path.ts`:

```ts
import { relative, resolve, sep } from "node:path";

export function assertInsideWorkspace(workspaceRoot: string, candidatePath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(workspaceRoot, candidatePath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`)) {
    throw new Error(`path outside workspace: ${candidatePath}`);
  }
  return rel || ".";
}
```

Create `src/storage/storage-manager.ts`:

```ts
import Database from "better-sqlite3";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Artifact } from "../contracts/types.js";
import { nowIso } from "../utils/clock.js";
import { schemaSql } from "./schema.js";

export interface StoragePaths {
  workspaceRoot: string;
  agentRoot: string;
  databasePath: string;
  artifactsRoot: string;
  memoryRoot: string;
}

export interface WriteArtifactInput {
  id: string;
  sessionId: string;
  turnId?: string;
  type: Artifact["type"];
  path: string;
  content: string;
}

export class StorageManager {
  private constructor(
    public readonly paths: StoragePaths,
    public readonly db: Database.Database
  ) {}

  static async init(workspaceRoot: string): Promise<StorageManager> {
    const agentRoot = join(workspaceRoot, ".figo-agent");
    const artifactsRoot = join(agentRoot, "artifacts");
    const memoryRoot = join(agentRoot, "memory");
    await mkdir(join(artifactsRoot, "sessions"), { recursive: true });
    await mkdir(memoryRoot, { recursive: true });

    const databasePath = join(agentRoot, "figo-agent.db");
    const db = new Database(databasePath);
    db.exec(schemaSql);

    return new StorageManager({ workspaceRoot, agentRoot, databasePath, artifactsRoot, memoryRoot }, db);
  }

  getSessionDir(sessionId: string): string {
    return join(this.paths.workspaceRoot, ".figo-agent", "artifacts", "sessions", sessionId);
  }

  async writeArtifact(input: WriteArtifactInput): Promise<Artifact> {
    const absolutePath = join(this.paths.workspaceRoot, input.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    const tmpPath = `${absolutePath}.tmp`;
    await writeFile(tmpPath, input.content, "utf8");
    await rename(tmpPath, absolutePath);
    const bytes = Buffer.byteLength(input.content, "utf8");
    const createdAt = nowIso();

    this.db.prepare(
      "insert into artifacts (id, session_id, turn_id, type, path, bytes, created_at) values (?, ?, ?, ?, ?, ?, ?)"
    ).run(input.id, input.sessionId, input.turnId ?? null, input.type, input.path, bytes, createdAt);

    return { id: input.id, sessionId: input.sessionId, turnId: input.turnId, type: input.type, path: input.path, bytes, createdAt };
  }
}
```

- [ ] **Step 4: Verify storage**

Run:

```bash
npm test -- tests/storage/storage-manager.test.ts
npm run typecheck
```

Expected:

```text
storage-manager.test.ts passes
TypeScript exits with code 0
```

---

### Task 4: Trace Recorder

**Files:**
- Create: `src/trace/trace-recorder.ts`
- Test: `tests/trace/trace-recorder.test.ts`

**Interfaces:**
- Consumes: `StorageManager` from Task 3.
- Produces: `TraceRecorder.record(input)`.

- [ ] **Step 1: Write trace test**

Create `tests/trace/trace-recorder.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StorageManager } from "../../src/storage/storage-manager.js";
import { TraceRecorder } from "../../src/trace/trace-recorder.js";

let workspace = "";

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("TraceRecorder", () => {
  it("writes trace_events and trace.jsonl", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    const storage = await StorageManager.init(workspace);
    storage.db.prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)").run("ses_1", workspace, "active", "2026-10-10T00:00:00.000Z");

    const recorder = new TraceRecorder(storage);
    await recorder.record({
      sessionId: "ses_1",
      type: "session.started",
      source: "AgentKernel",
      payload: { cwd: workspace }
    });

    const row = storage.db.prepare("select type from trace_events where session_id = ?").get("ses_1") as { type: string };
    expect(row.type).toBe("session.started");
    const jsonl = await readFile(join(workspace, ".figo-agent/artifacts/sessions/ses_1/trace.jsonl"), "utf8");
    expect(jsonl).toContain("session.started");
  });
});
```

- [ ] **Step 2: Implement TraceRecorder**

Create `src/trace/trace-recorder.ts`:

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TraceEvent, TraceEventType } from "../contracts/types.js";
import { nowIso } from "../utils/clock.js";
import { createId } from "../utils/id.js";
import type { StorageManager } from "../storage/storage-manager.js";

export interface TraceEventInput {
  sessionId: string;
  turnId?: string;
  type: TraceEventType;
  source: string;
  payload?: Record<string, unknown>;
}

export class TraceRecorder {
  constructor(private readonly storage: StorageManager) {}

  async record(input: TraceEventInput): Promise<TraceEvent> {
    const event: TraceEvent = {
      id: createId("trc"),
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: input.type,
      source: input.source,
      payload: sanitizePayload(input.payload ?? {}),
      createdAt: nowIso()
    };

    this.storage.db.prepare(
      "insert into trace_events (id, session_id, turn_id, type, source, payload_json, created_at) values (?, ?, ?, ?, ?, ?, ?)"
    ).run(event.id, event.sessionId, event.turnId ?? null, event.type, event.source, JSON.stringify(event.payload), event.createdAt);

    const jsonlPath = join(this.storage.paths.workspaceRoot, ".figo-agent", "artifacts", "sessions", event.sessionId, "trace.jsonl");
    await mkdir(dirname(jsonlPath), { recursive: true });
    await appendFile(jsonlPath, `${JSON.stringify(event)}\n`, "utf8");

    return event;
  }
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/apikey|token|secret|password/i.test(key)) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
```

- [ ] **Step 3: Verify trace**

Run:

```bash
npm test -- tests/trace/trace-recorder.test.ts
npm run typecheck
```

Expected:

```text
trace-recorder.test.ts passes
TypeScript exits with code 0
```

---

### Task 5: PluginHost, Policy, And MiniMax LLM Interface

**Files:**
- Create: `src/plugin/plugin-host.ts`
- Create: `src/policy/read-only-policy.ts`
- Create: `src/llm/openai-compatible-provider.ts`
- Test: `tests/plugin/plugin-host.test.ts`
- Test: `tests/policy/read-only-policy.test.ts`

**Interfaces:**
- Produces: `PluginHost`
- Produces: `ReadOnlyPolicy`
- Produces: `OpenAICompatibleProvider`
- Produces: MiniMax environment configuration via `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`.

- [ ] **Step 1: Write PluginHost test**

Create `tests/plugin/plugin-host.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PluginHost } from "../../src/plugin/plugin-host.js";

describe("PluginHost", () => {
  it("registers capabilities and rejects duplicates", async () => {
    const host = new PluginHost();
    host.register({
      manifest: {
        id: "p1",
        name: "Plugin 1",
        version: "0.1.0",
        description: "test",
        capabilities: [{ type: "tool", name: "read_file", description: "read" }]
      },
      setup: async () => ({ capabilities: [{ type: "tool", name: "read_file", value: { name: "read_file" } }] })
    });

    await host.setupAll({} as never);
    expect(host.getCapability("tool", "read_file")).toBeTruthy();

    expect(() => host.register({
      manifest: {
        id: "p1",
        name: "Plugin duplicate",
        version: "0.1.0",
        description: "dup",
        capabilities: []
      },
      setup: async () => ({ capabilities: [] })
    })).toThrow("duplicate plugin id");
  });
});
```

- [ ] **Step 2: Implement PluginHost**

Create `src/plugin/plugin-host.ts`:

```ts
export type CapabilityType = "llmProvider" | "contextSource" | "memoryStore" | "skill" | "tool" | "reporter" | "policy";

export interface CapabilityDeclaration {
  type: CapabilityType;
  name: string;
  description: string;
}

export interface Capability {
  type: CapabilityType;
  name: string;
  value: unknown;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: CapabilityDeclaration[];
}

export interface Plugin {
  manifest: PluginManifest;
  setup(context: unknown): Promise<{ capabilities: Capability[] }>;
}

export class PluginHost {
  private readonly plugins = new Map<string, Plugin>();
  private readonly capabilities = new Map<string, Capability>();

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`duplicate plugin id: ${plugin.manifest.id}`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  async setupAll(context: unknown): Promise<void> {
    for (const plugin of this.plugins.values()) {
      const result = await plugin.setup(context);
      for (const capability of result.capabilities) {
        const key = capabilityKey(capability.type, capability.name);
        if (this.capabilities.has(key)) {
          throw new Error(`duplicate capability: ${key}`);
        }
        this.capabilities.set(key, capability);
      }
    }
  }

  getCapability<T>(type: CapabilityType, name: string): T {
    const capability = this.capabilities.get(capabilityKey(type, name));
    if (!capability) {
      throw new Error(`missing capability: ${type}:${name}`);
    }
    return capability.value as T;
  }

  getCapabilities<T>(type: CapabilityType): T[] {
    return [...this.capabilities.values()]
      .filter((capability) => capability.type === type)
      .map((capability) => capability.value as T);
  }
}

function capabilityKey(type: CapabilityType, name: string): string {
  return `${type}:${name}`;
}
```

- [ ] **Step 3: Write and implement ReadOnlyPolicy**

Create `tests/policy/read-only-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ReadOnlyPolicy } from "../../src/policy/read-only-policy.js";

describe("ReadOnlyPolicy", () => {
  it("allows read-only tools", async () => {
    const policy = new ReadOnlyPolicy("/workspace");
    await expect(policy.evaluate({
      sessionId: "ses_1",
      turnId: "turn_1",
      action: "tool.read_file",
      resource: "/workspace/readme.md",
      metadata: {}
    })).resolves.toMatchObject({ allowed: true });
  });

  it("denies write actions", async () => {
    const policy = new ReadOnlyPolicy("/workspace");
    await expect(policy.evaluate({
      sessionId: "ses_1",
      turnId: "turn_1",
      action: "tool.write_file",
      resource: "/workspace/a.md",
      metadata: {}
    })).resolves.toMatchObject({ allowed: false, code: "tool_not_allowed" });
  });
});
```

Create `src/policy/read-only-policy.ts`:

```ts
import { resolve } from "node:path";
import type { Policy, PolicyDecision, PolicyRequest } from "../contracts/types.js";

const allowedActions = new Set(["tool.list_files", "tool.read_file", "tool.search_text"]);

export class ReadOnlyPolicy implements Policy {
  constructor(private readonly workspaceRoot: string) {}

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    if (!allowedActions.has(request.action)) {
      return { allowed: false, reason: `action denied: ${request.action}`, code: "tool_not_allowed" };
    }
    const root = resolve(this.workspaceRoot);
    const target = resolve(request.resource);
    if (!target.startsWith(root)) {
      return { allowed: false, reason: "resource outside workspace", code: "path_outside_workspace" };
    }
    return { allowed: true, reason: "allowed", code: "allowed" };
  }
}
```

- [ ] **Step 4: Add MiniMax OpenAI-compatible provider**

Create `src/llm/openai-compatible-provider.ts`:

```ts
import type { LLMProvider, LLMRequest, LLMResponse } from "../contracts/types.js";
import { createId } from "../utils/id.js";

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly options: { apiKey?: string; baseUrl: string; model: string }) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
      apiKey: env.MINIMAX_API_KEY,
      baseUrl: env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1",
      model: env.MINIMAX_MODEL ?? "MiniMax-M2.7"
    });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.options.apiKey) {
      return {
        id: createId("llm"),
        requestId: request.id,
        content: "未配置 MiniMax API Key，V1 返回本地占位响应。",
        model: this.options.model,
        finishReason: "stop",
        outputLength: 28,
        durationMs: 0
      };
    }

    const started = Date.now();
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: request.messages
      })
    });
    if (!response.ok) {
      throw new Error(`llm request failed: ${response.status}`);
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    return {
      id: createId("llm"),
      requestId: request.id,
      content,
      model: this.options.model,
      finishReason: "stop",
      outputLength: content.length,
      durationMs: Date.now() - started
    };
  }
}
```

Key handling rule: implementation reads `MINIMAX_API_KEY` from process environment only. Do not hardcode keys in tests, docs, source, TraceEvent payloads, SQLite rows, JSONL, Markdown artifacts, or committed shell scripts.

- [ ] **Step 5: Add MiniMax provider test without real key**

Create `tests/llm/openai-compatible-provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible-provider.js";

describe("OpenAICompatibleProvider", () => {
  it("uses MiniMax env defaults and local fallback without an API key", async () => {
    const provider = OpenAICompatibleProvider.fromEnv({
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
      MINIMAX_MODEL: "MiniMax-M2.7"
    });

    const response = await provider.complete({
      id: "llm_req_1",
      sessionId: "ses_1",
      turnId: "turn_1",
      contextPackId: "ctx_1",
      messages: [{ role: "user", content: "你好" }],
      model: "MiniMax-M2.7"
    });

    expect(response.model).toBe("MiniMax-M2.7");
    expect(response.content).toContain("未配置 MiniMax API Key");
  });
});
```

- [ ] **Step 6: Add optional live MiniMax smoke test command**

Do not commit API keys. Run live smoke only after exporting the key in the local shell:

```bash
export MINIMAX_API_KEY="<local secret>"
export MINIMAX_BASE_URL="https://api.minimaxi.com/v1"
export MINIMAX_MODEL="MiniMax-M2.7"
npm test -- tests/llm/openai-compatible-provider.test.ts
```

Expected:

```text
Provider fallback test passes.
Live API call is not required for CI.
```

- [ ] **Step 7: Verify plugin, policy, and MiniMax provider**

Run:

```bash
npm test -- tests/plugin/plugin-host.test.ts tests/policy/read-only-policy.test.ts tests/llm/openai-compatible-provider.test.ts
npm run typecheck
```

Expected:

```text
plugin-host.test.ts passes
read-only-policy.test.ts passes
openai-compatible-provider.test.ts passes
TypeScript exits with code 0
```

---

### Task 6: Read-Only Tools And ToolRegistry

**Files:**
- Create: `src/tools/read-only-tools.ts`
- Create: `src/tools/tool-registry.ts`
- Test: `tests/tools/read-only-tools.test.ts`

**Interfaces:**
- Consumes: `Policy` from Task 5.
- Produces: `ToolRegistry.call(name, input, context)`.

- [ ] **Step 1: Write tools test**

Create `tests/tools/read-only-tools.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadOnlyPolicy } from "../../src/policy/read-only-policy.js";
import { createReadOnlyTools } from "../../src/tools/read-only-tools.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

let workspace = "";

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("read-only tools", () => {
  it("reads files and searches text", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-agent-"));
    await writeFile(join(workspace, "readme.md"), "# Hello Agent\n", "utf8");
    const registry = new ToolRegistry(createReadOnlyTools(), new ReadOnlyPolicy(workspace));

    const read = await registry.call("read_file", { path: "readme.md" }, { sessionId: "ses_1", turnId: "turn_1", workspaceRoot: workspace });
    expect(read.status).toBe("completed");

    const search = await registry.call("search_text", { pattern: "Agent" }, { sessionId: "ses_1", turnId: "turn_1", workspaceRoot: workspace });
    expect(search.status).toBe("completed");
  });
});
```

- [ ] **Step 2: Implement tools and registry**

Create `src/tools/read-only-tools.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "../contracts/types.js";

export function createReadOnlyTools(): Tool[] {
  return [listFilesTool, readFileTool, searchTextTool];
}

const listFilesTool: Tool<{ path?: string }, { entries: string[] }> = {
  name: "list_files",
  description: "列出工作区内目录",
  async execute(input, context) {
    const dir = join(context.workspaceRoot, input.path ?? ".");
    const entries = await readdir(dir);
    return { status: "completed", output: { entries: entries.filter((entry) => !ignored.has(entry)) } };
  }
};

const readFileTool: Tool<{ path: string }, { content: string; bytes: number }> = {
  name: "read_file",
  description: "读取工作区内文件",
  async execute(input, context) {
    const content = await readFile(join(context.workspaceRoot, input.path), "utf8");
    return { status: "completed", output: { content, bytes: Buffer.byteLength(content, "utf8") } };
  }
};

const searchTextTool: Tool<{ pattern: string }, { matches: Array<{ path: string; line: number; text: string }> }> = {
  name: "search_text",
  description: "搜索工作区内文本",
  async execute(input, context) {
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const readmePath = join(context.workspaceRoot, "readme.md");
    const content = await readFile(readmePath, "utf8").catch(() => "");
    content.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(input.pattern)) matches.push({ path: "readme.md", line: index + 1, text: line });
    });
    return { status: "completed", output: { matches } };
  }
};

const ignored = new Set([".git", "node_modules", ".figo-agent", "dist", "build", "coverage"]);
```

Create `src/tools/tool-registry.ts`:

```ts
import { join } from "node:path";
import type { Policy, Tool, ToolExecutionContext, ToolResult } from "../contracts/types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[], private readonly policy: Policy) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  async call(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { status: "failed", errorMessage: `tool not found: ${name}`, errorCode: "tool_not_found" };

    const action = `tool.${name}` as never;
    const resource = resourceFromInput(context.workspaceRoot, input);
    const decision = await this.policy.evaluate({ sessionId: context.sessionId, turnId: context.turnId, action, resource, metadata: { input } });
    if (!decision.allowed) {
      return { status: "failed", errorMessage: decision.reason, errorCode: decision.code };
    }
    return tool.execute(input as never, context);
  }
}

function resourceFromInput(workspaceRoot: string, input: unknown): string {
  if (typeof input === "object" && input && "path" in input && typeof (input as { path: unknown }).path === "string") {
    return join(workspaceRoot, (input as { path: string }).path);
  }
  return workspaceRoot;
}
```

- [ ] **Step 3: Verify tools**

Run:

```bash
npm test -- tests/tools/read-only-tools.test.ts
npm run typecheck
```

Expected:

```text
read-only-tools.test.ts passes
TypeScript exits with code 0
```

---

### Task 7: Context, Memory, Reporter

**Files:**
- Create: `src/context/context-builder.ts`
- Create: `src/memory/sqlite-memory-store.ts`
- Create: `src/reporter/markdown-reporter.ts`
- Test: `tests/context/context-builder.test.ts`
- Test: `tests/reporter/markdown-reporter.test.ts`

**Interfaces:**
- Consumes: `StorageManager`.
- Produces: `ContextBuilder.build(session, turn)`.
- Produces: `MarkdownReporter.writeContext(contextPack)`.
- Produces: `MarkdownReporter.writeReport(input)`.

- [ ] **Step 1: Implement ContextBuilder**

Create `src/context/context-builder.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextItem, ContextPack, Session, Turn } from "../contracts/types.js";
import { nowIso } from "../utils/clock.js";
import { createId } from "../utils/id.js";
import type { StorageManager } from "../storage/storage-manager.js";

export class ContextBuilder {
  constructor(private readonly storage: StorageManager) {}

  async build(session: Session, turn: Turn): Promise<ContextPack> {
    const items: ContextItem[] = [];
    const files = ["AGENTS.MD", "readme.md"];
    for (const file of files) {
      const content = await readFile(join(session.cwd, file), "utf8").catch(() => "");
      if (content) {
        items.push({
          id: createId("ctx_item"),
          sourceType: "file",
          sourceRef: file,
          summary: `${file} 内容摘要`,
          content,
          estimatedTokens: estimateTokens(content),
          included: true,
          reason: "V1 项目理解基础文件"
        });
      }
    }
    items.push({
      id: createId("ctx_item"),
      sourceType: "turn",
      sourceRef: turn.id,
      summary: "当前用户输入",
      content: turn.input,
      estimatedTokens: estimateTokens(turn.input),
      included: true,
      reason: "当前 Turn 输入"
    });

    const pack: ContextPack = {
      id: createId("ctx"),
      sessionId: session.id,
      turnId: turn.id,
      items,
      estimatedTokens: items.reduce((sum, item) => sum + item.estimatedTokens, 0),
      createdAt: nowIso()
    };

    this.storage.db.prepare(
      "insert into context_packs (id, session_id, turn_id, estimated_tokens, created_at) values (?, ?, ?, ?, ?)"
    ).run(pack.id, pack.sessionId, pack.turnId, pack.estimatedTokens, pack.createdAt);

    const insertItem = this.storage.db.prepare(
      "insert into context_items (id, context_pack_id, source_type, source_ref, summary, estimated_tokens, included, reason) values (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const item of pack.items) {
      insertItem.run(item.id, pack.id, item.sourceType, item.sourceRef, item.summary, item.estimatedTokens, item.included ? 1 : 0, item.reason);
    }
    return pack;
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

- [ ] **Step 2: Implement memory store**

Create `src/memory/sqlite-memory-store.ts`:

```ts
import type { StorageManager } from "../storage/storage-manager.js";

export interface MemoryRecord {
  id: string;
  scope: string;
  key: string;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export class SQLiteMemoryStore {
  constructor(private readonly storage: StorageManager) {}

  search(scope: string): MemoryRecord[] {
    return this.storage.db.prepare(
      "select id, scope, key, content, source, created_at as createdAt, updated_at as updatedAt from memory_records where scope = ? order by updated_at desc limit 20"
    ).all(scope) as MemoryRecord[];
  }
}
```

- [ ] **Step 3: Implement MarkdownReporter**

Create `src/reporter/markdown-reporter.ts`:

```ts
import type { Artifact, ContextPack, Session, Turn, TurnResult } from "../contracts/types.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { createId } from "../utils/id.js";

export class MarkdownReporter {
  constructor(private readonly storage: StorageManager) {}

  async writeContext(pack: ContextPack): Promise<Artifact> {
    const body = [
      "# Context Pack",
      "",
      "## 基本信息",
      "",
      `- sessionId: ${pack.sessionId}`,
      `- turnId: ${pack.turnId}`,
      `- contextPackId: ${pack.id}`,
      `- estimatedTokens: ${pack.estimatedTokens}`,
      "",
      "## Included Items",
      "",
      ...pack.items.map((item) => `- ${item.sourceType}:${item.sourceRef}，${item.summary}，${item.estimatedTokens} tokens`)
    ].join("\n");
    return this.storage.writeArtifact({
      id: createId("art"),
      sessionId: pack.sessionId,
      turnId: pack.turnId,
      type: "context",
      path: `.figo-agent/artifacts/sessions/${pack.sessionId}/context.md`,
      content: body
    });
  }

  async writeReport(input: { session: Session; turn: Turn; result: TurnResult; contextPack: ContextPack }): Promise<Artifact> {
    const body = [
      "# Figo Agent Report",
      "",
      "## 基本信息",
      "",
      `- sessionId: ${input.session.id}`,
      `- turnId: ${input.turn.id}`,
      `- status: ${input.result.status}`,
      "",
      "## 用户目标",
      "",
      input.turn.input,
      "",
      "## 执行摘要",
      "",
      input.result.message,
      "",
      "## 上下文来源",
      "",
      ...input.contextPack.items.map((item) => `- ${item.sourceRef}: ${item.reason}`)
    ].join("\n");
    return this.storage.writeArtifact({
      id: createId("art"),
      sessionId: input.session.id,
      turnId: input.turn.id,
      type: "report",
      path: `.figo-agent/artifacts/sessions/${input.session.id}/report.md`,
      content: body
    });
  }
}
```

- [ ] **Step 4: Add tests**

Create `tests/context/context-builder.test.ts` and `tests/reporter/markdown-reporter.test.ts` using the StorageManager pattern from Task 3. Verify:

```ts
expect(pack.items.length).toBeGreaterThan(0);
expect(pack.estimatedTokens).toBeGreaterThan(0);
expect(artifact.path).toContain("context.md");
expect(artifact.path).toContain("report.md");
```

- [ ] **Step 5: Verify context and reporter**

Run:

```bash
npm test -- tests/context/context-builder.test.ts tests/reporter/markdown-reporter.test.ts
npm run typecheck
```

Expected:

```text
context-builder.test.ts passes
markdown-reporter.test.ts passes
TypeScript exits with code 0
```

---

### Task 8: Skill And AgentLoop

**Files:**
- Create: `src/skill/project-understanding-skill.ts`
- Create: `src/loop/agent-loop.ts`
- Test: `tests/e2e/project-understanding.test.ts`

**Interfaces:**
- Consumes: `ContextBuilder`, `LLMProvider`, `ToolRegistry`, `MarkdownReporter`, `TraceRecorder`.
- Produces: `AgentLoop.run(session, turn)`.

- [ ] **Step 1: Implement project-understanding skill**

Create `src/skill/project-understanding-skill.ts`:

```ts
import type { Artifact, ContextPack, LLMResponse, Turn } from "../contracts/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

export class ProjectUnderstandingSkill {
  readonly name = "project-understanding-skill";

  match(turn: Turn): boolean {
    return /项目|理解|架构|梳理|分析|agent/i.test(turn.input);
  }

  async run(input: {
    turn: Turn;
    contextPack: ContextPack;
    llmResponse: LLMResponse;
    toolRegistry: ToolRegistry;
    workspaceRoot: string;
  }): Promise<{ message: string; artifacts: Artifact[] }> {
    await input.toolRegistry.call("list_files", { path: "." }, { sessionId: input.contextPack.sessionId, turnId: input.turn.id, workspaceRoot: input.workspaceRoot });
    return {
      message: `已完成项目理解：读取 ${input.contextPack.items.length} 个上下文条目。模型摘要：${input.llmResponse.content}`,
      artifacts: []
    };
  }
}
```

- [ ] **Step 2: Implement AgentLoop**

Create `src/loop/agent-loop.ts`:

```ts
import type { LLMProvider, Session, Turn, TurnResult } from "../contracts/types.js";
import { createId } from "../utils/id.js";
import type { ContextBuilder } from "../context/context-builder.js";
import type { MarkdownReporter } from "../reporter/markdown-reporter.js";
import type { TraceRecorder } from "../trace/trace-recorder.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ProjectUnderstandingSkill } from "../skill/project-understanding-skill.js";

export class AgentLoop {
  constructor(private readonly deps: {
    contextBuilder: ContextBuilder;
    llmProvider: LLMProvider;
    toolRegistry: ToolRegistry;
    skill: ProjectUnderstandingSkill;
    reporter: MarkdownReporter;
    trace: TraceRecorder;
    workspaceRoot: string;
  }) {}

  async run(session: Session, turn: Turn): Promise<TurnResult> {
    await this.deps.trace.record({ sessionId: session.id, turnId: turn.id, type: "turn.processing", source: "AgentLoop", payload: {} });
    const contextPack = await this.deps.contextBuilder.build(session, turn);
    await this.deps.trace.record({ sessionId: session.id, turnId: turn.id, type: "context.build.completed", source: "ContextBuilder", payload: { contextPackId: contextPack.id, estimatedTokens: contextPack.estimatedTokens } });

    await this.deps.trace.record({ sessionId: session.id, turnId: turn.id, type: "llm.called", source: "LLMProvider", payload: { contextPackId: contextPack.id } });
    const llmResponse = await this.deps.llmProvider.complete({
      id: createId("llm_req"),
      sessionId: session.id,
      turnId: turn.id,
      contextPackId: contextPack.id,
      model: "default",
      messages: [{ role: "user", content: turn.input }],
      estimatedInputTokens: contextPack.estimatedTokens
    });
    await this.deps.trace.record({ sessionId: session.id, turnId: turn.id, type: "llm.completed", source: "LLMProvider", payload: { outputLength: llmResponse.outputLength } });

    const skillResult = await this.deps.skill.run({ turn, contextPack, llmResponse, toolRegistry: this.deps.toolRegistry, workspaceRoot: this.deps.workspaceRoot });
    await this.deps.trace.record({ sessionId: session.id, turnId: turn.id, type: "skill.completed", source: "SkillRunner", payload: { skillName: this.deps.skill.name } });

    const contextArtifact = await this.deps.reporter.writeContext(contextPack);
    const result: TurnResult = { sessionId: session.id, turnId: turn.id, status: "completed", message: skillResult.message, artifacts: [contextArtifact] };
    const reportArtifact = await this.deps.reporter.writeReport({ session, turn, result, contextPack });
    result.artifacts.push(reportArtifact);
    await this.deps.trace.record({ sessionId: session.id, turnId: turn.id, type: "turn.completed", source: "AgentLoop", payload: { artifactCount: result.artifacts.length } });
    return result;
  }
}
```

- [ ] **Step 3: Add e2e test**

Create `tests/e2e/project-understanding.test.ts` that creates a temp workspace with `readme.md`, initializes Storage, Trace, ContextBuilder, mock LLMProvider, ToolRegistry, ProjectUnderstandingSkill, MarkdownReporter, AgentLoop, then asserts:

```ts
expect(result.status).toBe("completed");
expect(result.artifacts.some((artifact) => artifact.path.endsWith("context.md"))).toBe(true);
expect(result.artifacts.some((artifact) => artifact.path.endsWith("report.md"))).toBe(true);
```

- [ ] **Step 4: Verify loop**

Run:

```bash
npm test -- tests/e2e/project-understanding.test.ts
npm run typecheck
```

Expected:

```text
project-understanding.test.ts passes
TypeScript exits with code 0
```

---

### Task 9: AgentKernel And CLI

**Files:**
- Create: `src/kernel/session-manager.ts`
- Create: `src/kernel/turn-manager.ts`
- Create: `src/kernel/agent-kernel.ts`
- Create: `src/plugin/builtin-plugins.ts`
- Create: `src/cli/input-router.ts`
- Create: `src/cli/renderer.ts`
- Create: `src/cli/main.ts`
- Test: `tests/cli/input-router.test.ts`
- Test: `tests/kernel/agent-kernel.test.ts`

**Interfaces:**
- Produces: `AgentKernel.start(input)`.
- Produces: `AgentKernel.submitTurn(input)`.
- Produces: `figo-agent` CLI command.

- [ ] **Step 1: Implement input router**

Create `src/cli/input-router.ts`:

```ts
export type InputRoute =
  | { type: "empty" }
  | { type: "command"; command: "exit" | "context" | "memory" | "report" | "help" | "unknown"; raw: string }
  | { type: "turn"; input: string };

export function routeInput(input: string): InputRoute {
  const trimmed = input.trim();
  if (!trimmed) return { type: "empty" };
  if (!trimmed.startsWith("/")) return { type: "turn", input: trimmed };
  const command = trimmed.slice(1).split(/\s+/)[0] as InputRoute["command"];
  if (["exit", "context", "memory", "report", "help"].includes(command)) {
    return { type: "command", command, raw: trimmed };
  }
  return { type: "command", command: "unknown", raw: trimmed };
}
```

Create `tests/cli/input-router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { routeInput } from "../../src/cli/input-router.js";

describe("routeInput", () => {
  it("routes plain text as turn", () => {
    expect(routeInput("理解当前项目")).toEqual({ type: "turn", input: "理解当前项目" });
  });

  it("routes commands without creating turns", () => {
    expect(routeInput("/report")).toEqual({ type: "command", command: "report", raw: "/report" });
  });
});
```

- [ ] **Step 2: Implement managers and kernel**

Create `src/kernel/session-manager.ts`, `src/kernel/turn-manager.ts`, and `src/kernel/agent-kernel.ts` using StorageManager inserts and updates for `sessions` and `turns`. Required methods:

```ts
createSession(cwd: string): Session
endSession(sessionId: string): void
createTurn(sessionId: string, input: string): Turn
completeTurn(turnId: string): void
failTurn(turnId: string): void
start({ workspaceRoot }: { workspaceRoot: string }): Promise<KernelStartResult>
submitTurn(input: string): Promise<TurnResult>
handleCommand(command: string): Promise<{ status: "completed" | "failed"; message: string }>
shutdown(): Promise<void>
```

Use the exact startup order:

```text
StorageManager.init
TraceRecorder
ReadOnlyPolicy
ToolRegistry
ContextBuilder
OpenAICompatibleProvider
ProjectUnderstandingSkill
MarkdownReporter
AgentLoop
SessionManager.createSession
TraceRecorder.record(session.started)
```

- [ ] **Step 3: Implement renderer and CLI entry**

Create `src/cli/renderer.ts`:

```ts
import type { TurnResult } from "../contracts/types.js";

export function renderTurnResult(result: TurnResult): string {
  const artifacts = result.artifacts.map((artifact) => `- ${artifact.path}`).join("\n");
  return [`执行结果：${result.message}`, artifacts ? `产物：\n${artifacts}` : ""].filter(Boolean).join("\n");
}
```

Create `src/cli/main.ts`:

```ts
#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentKernel } from "../kernel/agent-kernel.js";
import { routeInput } from "./input-router.js";
import { renderTurnResult } from "./renderer.js";

const kernel = await AgentKernel.start({ workspaceRoot: process.cwd() });
const rl = createInterface({ input, output, prompt: "figo-agent> " });

console.log(`Figo Agent 已启动：${kernel.session.id}`);
rl.prompt();

for await (const line of rl) {
  const route = routeInput(line);
  if (route.type === "empty") {
    rl.prompt();
    continue;
  }
  if (route.type === "turn") {
    const result = await kernel.submitTurn(route.input);
    console.log(renderTurnResult(result));
    rl.prompt();
    continue;
  }
  if (route.command === "exit") {
    await kernel.shutdown();
    console.log("已退出当前 Session。");
    break;
  }
  const result = await kernel.handleCommand(route.command);
  console.log(result.message);
  rl.prompt();
}
```

- [ ] **Step 4: Verify kernel and CLI**

Run:

```bash
npm test -- tests/cli/input-router.test.ts tests/kernel/agent-kernel.test.ts
npm run build
```

Expected:

```text
input-router.test.ts passes
agent-kernel.test.ts passes
Build exits with code 0
```

---

### Task 10: V1 Smoke Validation And Docs Update

**Files:**
- Modify: `readme.md`
- Modify: `AGENTS.MD`
- Test: manual CLI smoke.

**Interfaces:**
- Consumes: final CLI from Task 9.
- Produces: documented run command and V1 smoke evidence.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected:

```text
All tests pass
TypeScript exits with code 0
Build exits with code 0
```

- [ ] **Step 2: Run CLI smoke with MiniMax env**

Do not paste API keys into committed files or command history examples. Set the real key only in the local shell before smoke testing.

Run:

```bash
export MINIMAX_API_KEY="<local secret>"
export MINIMAX_BASE_URL="https://api.minimaxi.com/v1"
export MINIMAX_MODEL="MiniMax-M2.7"
printf "理解当前项目\n/exit\n" | npm run dev
```

Expected files:

```text
.figo-agent/figo-agent.db
.figo-agent/artifacts/sessions/<session-id>/context.md
.figo-agent/artifacts/sessions/<session-id>/report.md
.figo-agent/artifacts/sessions/<session-id>/trace.jsonl
```

- [ ] **Step 3: Update readme**

Append to `readme.md`:

```markdown
## V1 本地运行

安装依赖：

```bash
npm install
```

启动 REPL：

```bash
npm run dev
```

V1 支持命令：

```text
/exit
/context
/memory
/report
/help
```

V1 会在工作区生成 `.figo-agent/`，其中 SQLite 是状态源，Markdown 是阅读产物，JSONL 是审计流水。
```

- [ ] **Step 4: Final status check**

Run:

```bash
git status --short
```

Expected:

```text
Shows source, tests, package files, docs, and generated .figo-agent if smoke was run
```

Do not commit `.figo-agent/`.

---

## Self-Review

Spec coverage:

- CLI / REPL: Task 9 and Task 10.
- Session / Turn: Task 9.
- SQLite state source: Task 3.
- TraceEvent and JSONL: Task 4.
- Static PluginHost: Task 5.
- Read-only Policy: Task 5 and Task 6.
- Read-only Tool set: Task 6.
- ContextPack: Task 7.
- Memory read path: Task 7.
- Reporter and Markdown artifacts: Task 7.
- project-understanding-skill: Task 8.
- AgentLoop: Task 8.
- V1 smoke validation: Task 10.

Placeholder scan:

- No placeholder markers.
- No unresolved sections.
- No unspecified task.

Type consistency:

- `Session`, `Turn`, `TraceEvent`, `ContextPack`, `LLMRequest`, `LLMResponse`, `PolicyDecision`, `ToolResult`, `TurnResult` are defined in Task 2.
- Later tasks consume the same names and method signatures.
