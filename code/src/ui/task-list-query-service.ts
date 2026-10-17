import { defaultTaskListSettings, readTaskListSettings, type TaskListSettings } from "../config/task-list-settings.js";
import type { TaskListItem, TaskListPage } from "../contracts/task-list.js";
import { zhCN } from "../i18n/catalog.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { redactForUi } from "./ui-redaction.js";

export interface TaskListOptions {
  page?: number;
  limit?: number;
  q?: string;
}

interface TaskListRow {
  id: string;
  sessionId: string;
  title: string;
  status: string;
  turnCount: number;
  updatedAt: string;
  firstInput: string | null;
  firstSessionInput: string | null;
}

// 先完整脱敏再裁切；相同规则也供原有Session/Task查询使用。
export function taskDisplayTitle(
  firstInput: unknown, fallback: string, secrets: string[] = [], maxChars = defaultTaskListSettings.titleMaxChars
): string {
  const normalize = (value: unknown) => String(redactForUi(value, secrets) ?? "").replace(/\s+/g, " ").trim();
  return (normalize(firstInput) || normalize(fallback)).slice(0, maxChars);
}

export function sessionDisplayTitle(
  firstInput: unknown, secrets: string[] = [], maxChars = defaultTaskListSettings.titleMaxChars
): string {
  return taskDisplayTitle(firstInput, zhCN.workbench.untitledSession, secrets, maxChars);
}

// 聚合原始Turn时间，不依赖Task更新时间是否随运行刷新。legacy按Session隔离。
const taskListSql = `
  with turn_activity as (
    select session_id, task_id, count(*) as turnCount,
           max(max(created_at, coalesce(completed_at, created_at))) as updatedAt
    from turns group by session_id, task_id
  ), candidates as (
    select t.id, t.session_id as sessionId, t.title, t.status,
           coalesce(a.turnCount, 0) as turnCount,
           max(t.updated_at, coalesce(a.updatedAt, t.updated_at)) as updatedAt,
           (select input from turns where session_id = t.session_id and task_id = t.id
            order by created_at, rowid limit 1) as firstInput
    from tasks t left join turn_activity a on a.task_id = t.id and a.session_id = t.session_id
    where t.title != 'default' or coalesce(a.turnCount, 0) > 0
    union all
    select 'legacy_' || a.session_id, a.session_id, ?, 'archived',
           a.turnCount, a.updatedAt,
           (select input from turns where session_id = a.session_id and task_id is null
            order by created_at, rowid limit 1)
    from turn_activity a where a.task_id is null
  ), titled as (
    select c.*, (select input from turns where session_id = c.sessionId
                 order by created_at, rowid limit 1) as firstSessionInput
    from candidates c join sessions s on s.id = c.sessionId
  ), filtered as (
    select * from titled
    where instr(lower(title), lower(?)) > 0
       or instr(lower(coalesce(firstInput, '')), lower(?)) > 0
       or instr(lower(coalesce(firstSessionInput, '')), lower(?)) > 0
  )
`;

export class TaskListQueryService {
  private readonly settings: TaskListSettings;

  constructor(
    private readonly storage: StorageManager,
    private readonly secrets: string[] = [],
    settings: TaskListSettings = defaultTaskListSettings
  ) {
    this.settings = readTaskListSettings(settings);
  }

  list(options: TaskListOptions = {}): TaskListPage {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("任务列表查询参数无效。");
    const { page = 1, limit = this.settings.pageSize, q = "" } = options;
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("任务列表页码无效。");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.settings.maxPageSize) {
      throw new Error("任务列表每页数量无效。");
    }
    if (typeof q !== "string" || q.length > this.settings.searchMaxChars) throw new Error("任务列表搜索词无效。");
    const search = q.trim();
    const { totalCount } = this.storage.db.prepare(`${taskListSql} select count(*) as totalCount from filtered`)
      .get(zhCN.workbench.legacyTaskTitle, search, search, search) as { totalCount: number };
    const totalPages = Math.ceil(totalCount / limit);
    const currentPage = Math.min(page, totalPages);
    if (totalCount === 0) return { tasks: [], totalCount, page: 0, totalPages: 0, pageSize: limit };
    const rows = this.storage.db.prepare(`${taskListSql}
      select * from filtered order by updatedAt desc, sessionId, id limit ? offset ?`)
      .all(zhCN.workbench.legacyTaskTitle, search, search, search, limit, (currentPage - 1) * limit) as unknown as TaskListRow[];
    const tasks: TaskListItem[] = rows.map(row => ({
      id: row.id, sessionId: row.sessionId,
      title: String(redactForUi(row.title, this.secrets)),
      displayTitle: taskDisplayTitle(row.firstInput, row.title, this.secrets, this.settings.titleMaxChars),
      sessionTitle: sessionDisplayTitle(row.firstSessionInput, this.secrets, this.settings.titleMaxChars),
      status: row.status, turnCount: row.turnCount, updatedAt: row.updatedAt
    }));
    return { tasks, totalCount, page: currentPage, totalPages, pageSize: limit };
  }
}
