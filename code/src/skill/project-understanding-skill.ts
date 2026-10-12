import type { Artifact, SkillRunResult, ToolResult } from "../contracts/types.js";
import type { StorageManager } from "../storage/storage-manager.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { nowShanghaiTime } from "../utils/clock.js";
import { createId } from "../utils/id.js";
import { defaultToolDefaults, type RuntimeToolDefaults } from "../config/runtime-behavior.js";

export interface ProjectUnderstandingSkillInput {
  sessionId: string;
  taskId: string;
  turnId: string;
  workspaceRoot: string;
  input: string;
}

export class ProjectUnderstandingSkill {
  public readonly name = "project-understanding-skill";

  constructor(
    private readonly storage: StorageManager,
    private readonly toolRegistry: ToolRegistry,
    private readonly defaults: RuntimeToolDefaults = defaultToolDefaults
  ) {}

  canHandle(input: string): boolean {
    return /^\/skill\s+project-understanding(?:\s|$)/i.test(input.trim());
  }

  async run(input: ProjectUnderstandingSkillInput): Promise<SkillRunResult> {
    if (!this.canHandle(input.input)) {
      return { status: "skipped", message: "未匹配项目理解 Skill。", artifacts: [] };
    }

    const skillRunId = createId("skill_run");
    const startedAt = nowShanghaiTime();
    this.storage.db
      .prepare(
        "insert into skill_runs (id, session_id, turn_id, skill_name, status, started_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run(skillRunId, input.sessionId, input.turnId, this.name, "running", startedAt);

    try {
      const listed = requireToolOutput<{ files: string[] }>(
        await this.toolRegistry.execute("list_files", { path: "." }, toolContext(input))
      );
      if (listed.files.length === 0) {
        const message = `当前工作区 ${input.workspaceRoot} 没有可分析的项目文件。请打开包含项目源码的文件夹。`;
        this.storage.db.prepare("update skill_runs set status = ?, completed_at = ?, error_message = ? where id = ?")
          .run("failed", nowShanghaiTime(), message, skillRunId);
        return { status: "failed", message, artifacts: [] };
      }

      const readmePath = listed.files.find((path) => !path.includes("/") && /^readme(?:\.[^/]+)?$/i.test(path));
      let readme = "未发现工作区根目录 README。";
      if (readmePath) {
        const result = requireToolOutput<{ content: string }>(
          await this.toolRegistry.execute("read_file", { path: readmePath }, toolContext(input))
        );
        readme = `${readmePath}:\n${result.content.slice(0, this.defaults.skillReadmeChars)}`;
      }
      const searched = requireToolOutput<{ matches: Array<{ path: string; line: number; text: string }> }>(
        await this.toolRegistry.execute("search_text", { query: "项目", path: "." }, toolContext(input))
      );
      const matches = searched.matches.slice(0, this.defaults.skillMatchCount).map((match) => `${match.path}:${match.line} ${match.text.slice(0, this.defaults.skillMatchChars)}`);

      const completedAt = nowShanghaiTime();
      this.storage.db
        .prepare("update skill_runs set status = ?, completed_at = ? where id = ?")
        .run("completed", completedAt, skillRunId);

      return {
        status: "completed",
        message: [
          `工作区预检发现 ${listed.files.length} 个文件。`,
          `文件列表：${listed.files.slice(0, this.defaults.skillFileCount).join(", ")}`,
          `README：${readme}`,
          `关键词检索：${matches.length ? matches.join("\n") : "没有匹配"}`
        ].join("\n"),
        artifacts: [] as Artifact[]
      };
    } catch (error) {
      const completedAt = nowShanghaiTime();
      this.storage.db
        .prepare("update skill_runs set status = ?, completed_at = ?, error_message = ? where id = ?")
        .run("failed", completedAt, error instanceof Error ? error.message : String(error), skillRunId);
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        artifacts: []
      };
    }
  }
}

function requireToolOutput<T>(result: ToolResult): T {
  if (result.status === "failed") throw new Error(result.errorMessage);
  return result.output as T;
}

function toolContext(input: ProjectUnderstandingSkillInput) {
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    turnId: input.turnId,
    workspaceRoot: input.workspaceRoot
  };
}
