import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startLocalApi } from "../src/ui/local-api.js";
import { createTraceInspectorFixture } from "./trace-inspector-fixture.js";

// 演示与真实工作区隔离，停止后删除夹具；不读取模型密钥或发起模型调用。
const root = await mkdtemp(join(tmpdir(), "figo-trace-demo-"));
const { kernel } = await createTraceInspectorFixture(root);
const api = await startLocalApi({ kernel, port: Number(process.env.FIGO_TRACE_DEMO_PORT ?? 4318),
  requireAccessCode: false, staticRoot: resolve("web/dist"), branch: "trace-inspector-demo" });
process.stdout.write(`Trace Inspector 隔离演示：${api.url}\n`);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await api.close();
  if (kernel.storage.db.isOpen) kernel.storage.db.close();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
