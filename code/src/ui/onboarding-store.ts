import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { GuideId } from "../config/onboarding-settings.js";
import { nowShanghaiTime } from "../utils/clock.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export class OnboardingStore {
  private constructor(private readonly db: DatabaseSyncType) {}

  static async open(configRoot: string): Promise<OnboardingStore> {
    const root = join(configRoot, ".figo-agent");
    await mkdir(root, { recursive: true });
    const db = new DatabaseSync(join(root, "onboarding.db"));
    try {
      db.exec("create table if not exists onboarding_views (guide_id text not null, revision text not null, seen_at text not null, primary key (guide_id, revision))");
      return new OnboardingStore(db);
    } catch (error) { db.close(); throw error; }
  }

  seen(revision: string): GuideId[] {
    return (this.db.prepare("select guide_id from onboarding_views where revision = ? order by guide_id").all(revision) as Array<{ guide_id: GuideId }>)
      .map((row) => row.guide_id);
  }

  markSeen(guide: GuideId, revision: string): void {
    this.db.prepare("insert or ignore into onboarding_views (guide_id, revision, seen_at) values (?, ?, ?)")
      .run(guide, revision, nowShanghaiTime());
  }

  close(): void { this.db.close(); }
}
