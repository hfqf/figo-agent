import { relative, resolve, sep } from "node:path";

export function assertInsideWorkspace(workspaceRoot: string, candidatePath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(workspaceRoot, candidatePath);
  const rel = relative(root, target);

  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`)) {
    throw new Error(`path outside workspace: ${candidatePath}`);
  }

  return rel || ".";
}
