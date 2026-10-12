import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const hiddenNames = new Set(["node_modules", "dist", "build", "coverage", "figo-agent.config.json"]);
const sensitiveName = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|(?:service[-_]?account|credentials?|secrets?)(?:[._-]|$))|\.(?:pem|key|p12|pfx|jks|keystore)$/i;
const maxPreviewBytes = 1024 * 1024;

export interface FileReference {
  path: string;
  startLine: number;
  endLine: number;
  version: string;
}

export interface ValidatedReference extends FileReference {
  content: string;
}

export class WorkspaceFileService {
  constructor(private readonly root: string) {}

  async search(query: string): Promise<Array<{ name: string; path: string; kind: "file" | "directory" }>> {
    const term = query.trim().toLowerCase();
    if (term.length < 2 || term.length > 80) throw new Error("搜索词长度无效。");
    const queue: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }];
    const results: Array<{ name: string; path: string; kind: "file" | "directory" }> = [];
    let visited = 0;
    while (queue.length && visited < 200 && results.length < 100) {
      const next = queue.shift()!;
      visited++;
      const { entries } = await this.list(next.path);
      for (const entry of entries) {
        if (entry.name.toLowerCase().includes(term)) results.push(entry);
        if (entry.kind === "directory" && next.depth < 7 && queue.length < 300) {
          queue.push({ path: entry.path, depth: next.depth + 1 });
        }
        if (results.length >= 100) break;
      }
    }
    return results;
  }

  async list(path: string): Promise<{ path: string; entries: Array<{ name: string; path: string; kind: "file" | "directory" }> }> {
    const target = await this.resolveSafe(path);
    const meta = await stat(target);
    if (!meta.isDirectory()) throw new Error("不是目录。");
    const names = await readdir(target, { withFileTypes: true });
    const entries: Array<{ name: string; path: string; kind: "file" | "directory" }> = [];
    for (const entry of names) {
      if (isHidden(entry.name)) continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      try {
        const safe = await this.resolveSafe(child);
        const childMeta = await stat(safe);
        if (!childMeta.isFile() && !childMeta.isDirectory()) continue;
        entries.push({ name: entry.name, path: child, kind: childMeta.isDirectory() ? "directory" : "file" });
      } catch { /* A denied or broken symlink is not listed. */ }
    }
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, "zh-CN") : a.kind === "directory" ? -1 : 1);
    return { path, entries: entries.slice(0, 500) };
  }

  async preview(path: string): Promise<{ path: string; content: string | null; size: number; lineCount: number; version: string | null; tooLarge: boolean }> {
    const target = await this.resolveSafe(path);
    const meta = await stat(target);
    if (!meta.isFile()) throw new Error("不是普通文件。");
    if (meta.size > maxPreviewBytes) return { path, content: null, size: meta.size, lineCount: 0, version: null, tooLarge: true };
    const bytes = await readFile(target);
    if (bytes.includes(0)) throw new Error("二进制文件不可预览。");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("二进制文件不可预览。"); }
    return {
      path, content, size: bytes.length,
      lineCount: content.split("\n").length - (content.endsWith("\n") ? 1 : 0),
      version: createHash("sha256").update(bytes).digest("hex"), tooLarge: false
    };
  }

  async save(path: string, content: string, version: string): Promise<Awaited<ReturnType<WorkspaceFileService["preview"]>>> {
    if (typeof content !== "string" || typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version)) {
      throw new Error("文件保存参数无效。");
    }
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > maxPreviewBytes) throw new Error("文件过大。");
    if (bytes.includes(0)) throw new Error("二进制文件不可编辑。");
    const target = await this.resolveSafe(path);
    const before = await this.preview(path);
    if (before.version !== version) throw new Error("文件已变化，请刷新预览。");
    const meta = await lstat(target);
    if (!meta.isFile() || meta.isSymbolicLink()) throw new Error("路径被拒绝。");
    const temporary = join(dirname(target), `.figo-save-${randomUUID()}`);
    try {
      const handle = await open(temporary, "wx", meta.mode & 0o777);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      const current = await this.preview(path);
      if (current.version !== version || (await lstat(target)).isSymbolicLink()) throw new Error("文件已变化，请刷新预览。");
      await rename(temporary, target);
      return await this.preview(path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async validateReference(ref: FileReference): Promise<ValidatedReference> {
    if (!Number.isSafeInteger(ref.startLine) || !Number.isSafeInteger(ref.endLine) ||
        ref.startLine < 1 || ref.endLine < ref.startLine || ref.endLine - ref.startLine >= 200) {
      throw new Error("引用行区间无效。");
    }
    const preview = await this.preview(ref.path);
    if (!preview.version || preview.version !== ref.version) throw new Error("文件已变化，请刷新预览。");
    const lines = preview.content!.split("\n");
    if (ref.endLine > preview.lineCount) throw new Error("引用行区间无效。");
    const content = lines.slice(ref.startLine - 1, ref.endLine).join("\n");
    if (content.length > 16000) throw new Error("引用内容过长。");
    return { ...ref, content };
  }

  private async resolveSafe(path: string): Promise<string> {
    if (typeof path !== "string" || path.includes("\\") || path.includes("\0") || isAbsolute(path)) {
      throw new Error("路径被拒绝。");
    }
    const segments = path.split("/");
    if (segments.some((segment) => segment === ".." || isHidden(segment))) throw new Error("路径被拒绝。");
    const rootReal = await realpath(this.root);
    const candidate = resolve(rootReal, path);
    const candidateRelative = relative(rootReal, candidate);
    if (candidateRelative.startsWith(`..${sep}`) || candidateRelative === ".." || isAbsolute(candidateRelative)) {
      throw new Error("路径被拒绝。");
    }
    try {
      let current = rootReal;
      for (const segment of segments.filter(Boolean)) {
        current = resolve(current, segment);
        if ((await lstat(current)).isSymbolicLink()) throw new Error("路径被拒绝。");
      }
      const actual = await realpath(candidate);
      const actualRelative = relative(rootReal, actual);
      if (actualRelative.startsWith(`..${sep}`) || actualRelative === ".." || isAbsolute(actualRelative)) {
        throw new Error("路径被拒绝。");
      }
      return actual;
    } catch (error) {
      if (error instanceof Error && error.message === "路径被拒绝。") throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("文件不存在。");
      throw new Error("路径被拒绝。");
    }
  }
}

function isHidden(name: string): boolean {
  return name.startsWith(".") || hiddenNames.has(name) || sensitiveName.test(name);
}
