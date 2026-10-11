# Tool Calling Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded LLM -> Tool -> LLM loop that executes structured tool calls through ToolRegistry and Policy, while preserving full context content in LLM requests.

**Architecture:** AgentLoop remains the small kernel. ToolCallParser owns the model-neutral JSON protocol, ToolCallingRuntime owns batch execution, ToolRegistry + Policy remain the only action execution surface.

**Tech Stack:** TypeScript, Vitest, Node.js, SQLite trace/capture tables, existing PluginHost and ToolRegistry.

## Global Constraints

- Documentation and report text use Chinese.
- Do not parse or execute `<function_calls>`.
- Do not execute shell commands extracted from natural language.
- Tool calls must go through ToolRegistry and ControlledToolPolicy.
- Tool loop default maximum is `3` rounds.
- LLM requests must include `ContextItem.content`.
- ToolResult sent back to LLM must be structured JSON and bounded.

---

### Task 1: ToolCallParser

**Files:**
- Create: `src/loop/tool-call-parser.ts`
- Test: `tests/loop/tool-call-parser.test.ts`

**Interfaces:**
- Produces: `ToolCallParser.parse(content: string): ParsedToolCalls`
- Produces: `ToolIntentCall { id: string; name: string; input: Record<string, unknown> }`

- [ ] **Step 1: Write failing parser tests**
- [ ] **Step 2: Verify tests fail with missing module**
- [ ] **Step 3: Implement strict fenced JSON parser**
- [ ] **Step 4: Verify parser tests pass**

### Task 2: LLM Message Builder

**Files:**
- Create: `src/loop/llm-message-builder.ts`
- Modify: `src/loop/agent-loop.ts`
- Test: `tests/loop/llm-message-builder.test.ts`

**Interfaces:**
- Consumes: `ContextPack`
- Produces: `buildInitialMessages(input: string, contextPack: ContextPack): LLMMessage[]`
- Produces: `buildToolResultMessage(results: ToolExecutionRecord[]): LLMMessage`

- [ ] **Step 1: Write failing tests proving ContextItem.content enters request**
- [ ] **Step 2: Verify tests fail with missing module**
- [ ] **Step 3: Implement message builder**
- [ ] **Step 4: Verify message builder tests pass**

### Task 3: ToolCallingRuntime

**Files:**
- Create: `src/loop/tool-calling-runtime.ts`
- Test: `tests/loop/tool-calling-runtime.test.ts`

**Interfaces:**
- Consumes: `ToolRegistry.execute(name, input, context)`
- Consumes: `ToolIntentCall[]`
- Produces: `executeBatch(calls, context, round): Promise<ToolExecutionRecord[]>`

- [ ] **Step 1: Write failing runtime tests**
- [ ] **Step 2: Verify tests fail with missing module**
- [ ] **Step 3: Implement runtime batch execution**
- [ ] **Step 4: Verify runtime tests pass**

### Task 4: AgentLoop Integration

**Files:**
- Modify: `src/contracts/types.ts`
- Modify: `src/loop/agent-loop.ts`
- Test: `tests/loop/agent-loop-tool-calling.test.ts`

**Interfaces:**
- Consumes: `ToolCallParser`
- Consumes: `ToolCallingRuntime`
- Consumes: `buildInitialMessages` and `buildToolResultMessage`

- [ ] **Step 1: Write failing AgentLoop tests for LLM -> Tool -> LLM**
- [ ] **Step 2: Verify tests fail because AgentLoop calls LLM once and no tool events exist**
- [ ] **Step 3: Integrate bounded tool loop**
- [ ] **Step 4: Verify AgentLoop tests pass**

### Task 5: Accident Regression and Verification

**Files:**
- Modify: `tests/e2e/task-context-boundary.test.ts`
- Modify: `docs/agent/modules/agent-loop/TOOL_CALLING_LOOP.md`
- Modify: `docs/agent/modules/agent-loop/ACCEPTANCE.md`

**Interfaces:**
- Consumes: completed AgentLoop Tool Calling Loop

- [ ] **Step 1: Add regression tests for history content and XML non-execution**
- [ ] **Step 2: Verify tests pass**
- [ ] **Step 3: Update acceptance documentation**
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run build`**

## Self-Review

1. Spec coverage: tasks cover parser, messages, runtime, AgentLoop loop, regression, docs.
2. Placeholder scan: no unfinished markers or undefined implementation steps.
3. Type consistency: parser emits `ToolIntentCall`; runtime emits `ToolExecutionRecord`; message builder consumes runtime records.
