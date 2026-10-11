import type { Artifact, SkillRunResult } from "../contracts/types.js";
import type { StorageManager } from "../storage/storage-manager.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { nowIso } from "../utils/clock.js";
import { createId } from "../utils/id.js";

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
    private readonly toolRegistry: ToolRegistry
  ) {}

  canHandle(input: string): boolean {
    return /理解.*项目|项目.*理解|读取.*项目|分析.*项目/.test(input);
  }

  async run(input: ProjectUnderstandingSkillInput): Promise<SkillRunResult> {
    if (!this.canHandle(input.input)) {
      return { status: "skipped", message: "未匹配项目理解 Skill。", artifacts: [] };
    }

    const skillRunId = createId("skill_run");
    const startedAt = nowIso();
    this.storage.db
      .prepare(
        "insert into skill_runs (id, session_id, turn_id, skill_name, status, started_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run(skillRunId, input.sessionId, input.turnId, this.name, "running", startedAt);

    try {
      await this.toolRegistry.execute("list_files", { path: "." }, toolContext(input));
      await this.toolRegistry.execute("read_file", { path: "readme.md" }, toolContext(input));
      await this.toolRegistry.execute("search_text", { query: "项目", path: "." }, toolContext(input));

      const completedAt = nowIso();
      this.storage.db
        .prepare("update skill_runs set status = ?, completed_at = ? where id = ?")
        .run("completed", completedAt, skillRunId);

      return {
        status: "completed",
        message: "项目理解完成：已读取项目文件列表、README，并完成关键词检索。",
        artifacts: [] as Artifact[]
      };
    } catch (error) {
      const completedAt = nowIso();
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

function toolContext(input: ProjectUnderstandingSkillInput) {
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    turnId: input.turnId,
    workspaceRoot: input.workspaceRoot
  };
}
