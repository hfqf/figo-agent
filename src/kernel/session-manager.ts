import type { Session } from "../contracts/types.js";
import type { StorageManager } from "../storage/storage-manager.js";
import { nowIso } from "../utils/clock.js";
import { createId } from "../utils/id.js";

export class SessionManager {
  constructor(private readonly storage: StorageManager) {}

  create(cwd: string): Session {
    const session: Session = {
      id: createId("ses"),
      cwd,
      status: "active",
      startedAt: nowIso()
    };
    this.storage.db
      .prepare("insert into sessions (id, cwd, status, started_at) values (?, ?, ?, ?)")
      .run(session.id, session.cwd, session.status, session.startedAt);
    return session;
  }

  end(sessionId: string): void {
    this.storage.db
      .prepare("update sessions set status = ?, ended_at = ? where id = ?")
      .run("ended", nowIso(), sessionId);
  }
}
