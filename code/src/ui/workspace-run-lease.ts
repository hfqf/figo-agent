import type { StorageManager } from "../storage/storage-manager.js";
import { nowShanghaiTime } from "../utils/clock.js";

export function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class WorkspaceRunLease {
  constructor(private readonly storage: StorageManager) {}

  acquire(holderId: string): () => void {
    const db = this.storage.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("select holder_id, owner_pid from agent_run_lease where singleton = 1")
        .get() as { holder_id: string; owner_pid: number } | undefined;
      if (current && isProcessAlive(current.owner_pid)) {
        throw new Error(`工作区已有执行中的 Agent：${current.holder_id}`);
      }
      db.prepare("insert into agent_run_lease (singleton, holder_id, owner_pid, acquired_at) values (1, ?, ?, ?) on conflict(singleton) do update set holder_id = excluded.holder_id, owner_pid = excluded.owner_pid, acquired_at = excluded.acquired_at")
        .run(holderId, process.pid, nowShanghaiTime());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return () => {
      db.prepare("delete from agent_run_lease where singleton = 1 and holder_id = ? and owner_pid = ?")
        .run(holderId, process.pid);
    };
  }
}
