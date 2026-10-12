import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceFileService } from "../../src/ui/workspace-files.js";

let workspace = "";
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

it("lists and previews text while rejecting secrets, traversal, binary and outbound symlinks", async () => {
  workspace = await mkdtemp(join(tmpdir(), "figo-ui-files-"));
  await writeFile(join(workspace, "readme.md"), "第一行\n第二行\n第三行\n");
  await writeFile(join(workspace, "figo-agent.config.json"), '{"apiKey":"secret"}');
  await writeFile(join(workspace, ".npmrc"), "//registry.example/:_authToken=secret");
  await writeFile(join(workspace, "private.pem"), "secret");
  await writeFile(join(workspace, "service-account.json"), "secret");
  await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
  await mkdir(join(workspace, "docs"));
  await writeFile(join(workspace, "docs", "note-architecture.md"), "内容");
  await symlink("/etc/hosts", join(workspace, "outside"));
  await symlink("figo-agent.config.json", join(workspace, "config-alias"));
  const files = new WorkspaceFileService(workspace);
  const names = (await files.list("")).entries.map((entry) => entry.name);
  expect(names).toContain("readme.md");
  expect(names).not.toContain("figo-agent.config.json");
  expect(names).not.toContain(".npmrc");
  expect(names).not.toContain("private.pem");
  expect(names).not.toContain("service-account.json");
  expect(names).not.toContain("outside");
  expect(names).not.toContain("config-alias");
  const preview = await files.preview("readme.md");
  expect(preview.content).toContain("第二行");
  await expect(files.validateReference({ path: "readme.md", startLine: 2, endLine: 2, version: preview.version! })).resolves.toMatchObject({ content: "第二行", path: "readme.md" });
  await expect(files.preview("../outside")).rejects.toThrow("路径被拒绝");
  await expect(files.preview("figo-agent.config.json")).rejects.toThrow("路径被拒绝");
  await expect(files.preview(".npmrc")).rejects.toThrow("路径被拒绝");
  await expect(files.preview("private.pem")).rejects.toThrow("路径被拒绝");
  await expect(files.preview("outside")).rejects.toThrow("路径被拒绝");
  await expect(files.preview("config-alias")).rejects.toThrow("路径被拒绝");
  await expect(files.preview("binary.bin")).rejects.toThrow("二进制");
  await expect(files.validateReference({ path: "readme.md", startLine: 2, endLine: 2, version: "old" })).rejects.toThrow("文件已变化");
  expect((await files.search("note")).map((entry) => entry.path)).toContain("docs/note-architecture.md");
});
