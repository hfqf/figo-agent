import { resolveWorkspace, WorkspaceRegistry } from "../ui/workspace-registry.js";

export async function chooseDesktopWorkspace(
  configRoot: string
): Promise<string | null> {
  const registry = await WorkspaceRegistry.open(configRoot);
  try {
    for (const recent of registry.recent()) {
      try { return await resolveWorkspace(recent); }
      catch { /* A missing recent directory does not block first-run selection. */ }
    }
  } finally { registry.close(); }
  return null;
}
