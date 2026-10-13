import { useEffect, useState, type FormEvent } from "react";
import { Check, FolderOpen, KeyRound, LoaderCircle, Save } from "lucide-react";
import messages from "../../locales/zh-CN.json";

interface SetupState {
  model: { id: string; baseUrl: string; model: string; configured: boolean };
  recent: string[];
}

interface SetupBridge {
  read(): Promise<SetupState>;
  saveModel(input: { baseUrl: string; model: string; apiKey: string }): Promise<SetupState["model"]>;
  pickWorkspace(): Promise<string | null>;
  openWorkspace(path: string): Promise<void>;
}

declare global {
  interface Window { figoSetup: SetupBridge }
}

const copy = messages.desktopSetup;

export function SetupApp() {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.figoSetup.read().then((value) => {
      setSetup(value); setBaseUrl(value.model.baseUrl); setModel(value.model.model);
    }).catch(() => setError(copy.loadFailed));
  }, []);

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setSaved(false);
    try {
      const result = await window.figoSetup.saveModel({ baseUrl, model, apiKey });
      setSetup((current) => current ? { ...current, model: result } : current);
      setApiKey(""); setSaved(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.saveFailed); }
    finally { setBusy(false); }
  }

  async function browse() {
    setBusy(true); setError("");
    try {
      const path = await window.figoSetup.pickWorkspace();
      if (path) setWorkspacePath(path);
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.openFailed); }
    finally { setBusy(false); }
  }

  async function open(path: string) {
    if (!path.trim()) return;
    setBusy(true); setError("");
    try { await window.figoSetup.openWorkspace(path.trim()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : copy.openFailed); setBusy(false); }
  }

  return <div className="setup-shell">
    <header className="setup-header"><div className="setup-mark">F</div><strong>Figo Agent</strong></header>
    <main className="setup-main">
      <h1>{copy.title}</h1>
      <form className="setup-form" onSubmit={(event) => void saveModel(event)}>
        <h2><KeyRound size={18} />{copy.modelSection}</h2>
        <label htmlFor="setup-base-url">{copy.baseUrl}</label>
        <input id="setup-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required disabled={busy || !setup} />
        <label htmlFor="setup-model">{copy.model}</label>
        <input id="setup-model" value={model} onChange={(event) => setModel(event.target.value)} required disabled={busy || !setup} />
        <label htmlFor="setup-api-key">{copy.apiKey}</label>
        <input id="setup-api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required={!setup?.model.configured} disabled={busy || !setup} placeholder={setup?.model.configured ? copy.keyConfigured : copy.keyRequired} />
        <div className="setup-form-actions"><button className="setup-primary" type="submit" disabled={busy || !setup}>{busy ? <LoaderCircle size={16} className="setup-spin" /> : <Save size={16} />}{copy.saveModel}</button>{saved && <span className="setup-saved"><Check size={15} />{copy.modelSaved}</span>}</div>
      </form>
      <section className="setup-workspace" aria-label={copy.workspaceSection}>
        <h2><FolderOpen size={18} />{copy.workspaceSection}</h2>
        {!setup?.model.configured && <p className="setup-hint">{copy.notConfigured}</p>}
        <label htmlFor="setup-workspace-path">{copy.folderPath}</label>
        <div className="setup-path-row"><input id="setup-workspace-path" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} disabled={busy || !setup?.model.configured} /><button type="button" className="setup-outline" onClick={() => void browse()} disabled={busy || !setup?.model.configured}><FolderOpen size={16} />{copy.browse}</button></div>
        <button type="button" className="setup-primary" onClick={() => void open(workspacePath)} disabled={busy || !setup?.model.configured || !workspacePath.trim()}>{busy ? <LoaderCircle size={16} className="setup-spin" /> : <FolderOpen size={16} />}{copy.open}</button>
        {Boolean(setup?.recent.length) && <div className="setup-recent"><h3>{copy.recent}</h3>{setup?.recent.map((path) => <button type="button" key={path} title={path} disabled={busy || !setup.model.configured} onClick={() => void open(path)}><FolderOpen size={16} /><span><b>{path.split("/").filter(Boolean).at(-1) ?? path}</b><small>{path}</small></span></button>)}</div>}
      </section>
      {error && <p className="setup-error" role="alert">{error}</p>}
    </main>
  </div>;
}
