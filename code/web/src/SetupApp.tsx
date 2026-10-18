import { useEffect, useState, type FormEvent } from "react";
import { Check, FolderOpen, KeyRound, LoaderCircle, RefreshCw, Save } from "lucide-react";
import messages from "../../locales/zh-CN.json";
import { BrandLogo } from "./BrandLogo";
import { modelFamilies, officialUrls, type ModelFamily } from "../../src/config/model-services.js";
import type { DesktopModelSetup, DesktopModelInput, DesktopModelDiscoveryInput } from "../../src/desktop/model-setup-contracts.js";

interface SetupState {
  model: DesktopModelSetup;
  recent: string[];
}

interface SetupBridge {
  read(): Promise<SetupState>;
  saveModel(input: DesktopModelInput): Promise<DesktopModelSetup>;
  discoverModels(input: DesktopModelDiscoveryInput): Promise<string[]>;
  pickWorkspace(): Promise<string | null>;
  openWorkspace(path: string): Promise<void>;
}

declare global {
  interface Window { figoSetup: SetupBridge }
}

const copy = messages.desktopSetup;
const modelCopy = messages.workbench;
const labels: Record<ModelFamily, string> = {
  minimax: modelCopy.modelMiniMax, deepseek: modelCopy.modelDeepSeek,
  "gpt-official": modelCopy.modelGptOfficial, "gpt-relay": modelCopy.modelGptRelay
};
const normalizedUrl = (value: string) => value.trim().replace(/\/+$/, "");

export function SetupApp() {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [family, setFamily] = useState<ModelFamily>("minimax");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const stored = setup?.model.settings.models.find(entry => entry.family === family && entry.id === setup.model.id)
    ?? setup?.model.settings.models.find(entry => entry.family === family);
  const sameConnection = Boolean(stored && normalizedUrl(stored.baseUrl) === normalizedUrl(baseUrl));
  const hasStoredKey = Boolean(sameConnection && stored?.hasApiKey);
  const choices = [...new Set([...(sameConnection && stored?.model ? [stored.model] : []), ...modelIds])];
  const ready = Boolean(setup?.model.configured && family === setup.model.family &&
    normalizedUrl(baseUrl) === normalizedUrl(setup.model.baseUrl) && model === setup.model.model && !apiKey);

  useEffect(() => {
    let cancelled = false;
    void window.figoSetup.read().then((value) => {
      if (cancelled) return;
      setSetup(value); setFamily(value.model.family); setBaseUrl(value.model.baseUrl); setModel(value.model.model);
    }).catch(() => { if (!cancelled) setError(copy.loadFailed); });
    return () => { cancelled = true; };
  }, []);

  function selectFamily(next: ModelFamily) {
    if (next === family) return;
    const entry = setup?.model.settings.models.find(item => item.family === next && item.id === setup.model.id)
      ?? setup?.model.settings.models.find(item => item.family === next);
    setFamily(next); setBaseUrl(entry?.baseUrl ?? (next === "gpt-relay" ? "" : officialUrls[next]));
    setModel(entry?.model ?? ""); setApiKey(""); setModelIds([]); setCatalogError(""); setError(""); setSaved(false);
  }

  async function discover() {
    if (busy || !setup) return;
    setBusy(true); setDiscovering(true); setCatalogError("");
    try {
      const ids = await window.figoSetup.discoverModels({ family, baseUrl, apiKey });
      setModelIds(ids);
      if (!ids.length) setCatalogError(modelCopy.modelListEmpty);
    } catch (reason) { setCatalogError(reason instanceof Error ? reason.message : modelCopy.modelListFailed); }
    finally { setBusy(false); setDiscovering(false); }
  }

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !setup) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const result = await window.figoSetup.saveModel({ family, baseUrl, model, apiKey, version: setup.model.settings.version });
      setSetup((current) => current ? { ...current, model: result } : current);
      setBaseUrl(result.baseUrl); setModel(result.model); setApiKey(""); setSaved(true);
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
    <header className="setup-header"><BrandLogo className="setup-mark" /><strong>Figo Agent</strong></header>
    <main className="setup-main">
      <h1>{copy.title}</h1>
      <form className="setup-form" onSubmit={(event) => void saveModel(event)}>
        <h2><KeyRound size={18} />{copy.modelSection}</h2>
        <div className="setup-services" role="group" aria-label={copy.service}>
          {modelFamilies.map(value => <button key={value} type="button" aria-pressed={family === value}
            disabled={busy || !setup} onClick={() => selectFamily(value)}>{labels[value]}</button>)}
        </div>
        <label htmlFor="setup-base-url">{copy.baseUrl}</label>
        <input id="setup-base-url" type="url" value={baseUrl} onChange={(event) => {
          setBaseUrl(event.target.value); setApiKey(""); setModel(""); setModelIds([]); setSaved(false); setCatalogError("");
        }} required disabled={busy || !setup || family !== "gpt-relay"} />
        <label htmlFor="setup-api-key">{copy.apiKey}</label>
        <input id="setup-api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => {
          setApiKey(event.target.value); setModelIds([]); setCatalogError(""); setSaved(false);
          if (!sameConnection || model !== stored?.model) setModel("");
        }} required={!hasStoredKey} disabled={busy || !setup} placeholder={hasStoredKey ? copy.keyConfigured : copy.keyRequired} />
        <div className="setup-model-heading"><label htmlFor="setup-model">{modelCopy.modelName}</label>
          <button type="button" className="setup-outline" onClick={() => void discover()} disabled={busy || !setup || !baseUrl.trim() || (!apiKey.trim() && !hasStoredKey)}>
            {discovering ? <LoaderCircle size={16} className="setup-spin" /> : <RefreshCw size={16} />}{modelCopy.modelListRefresh}
          </button>
        </div>
        <select id="setup-model" value={model} onChange={event => { setModel(event.target.value); setSaved(false); }} required disabled={busy || !setup}>
          <option value="" disabled>{modelCopy.modelChoose}</option>
          {choices.map(id => <option key={id} value={id}>{id}{!modelIds.includes(id) ? modelCopy.modelSavedSuffix : ""}</option>)}
        </select>
        {catalogError && <p className="setup-error" role="alert">{catalogError}</p>}
        <div className="setup-form-actions"><button className="setup-primary" type="submit" disabled={busy || !setup || !model || (!apiKey.trim() && !hasStoredKey)}>{busy && !discovering ? <LoaderCircle size={16} className="setup-spin" /> : <Save size={16} />}{copy.saveModel}</button>{saved && <span className="setup-saved" role="status"><Check size={15} />{copy.modelSaved}</span>}</div>
      </form>
      <section className="setup-workspace" aria-label={copy.workspaceSection}>
        <h2><FolderOpen size={18} />{copy.workspaceSection}</h2>
        {!ready && <p className="setup-hint">{copy.notConfigured}</p>}
        <label htmlFor="setup-workspace-path">{copy.folderPath}</label>
        <div className="setup-path-row"><input id="setup-workspace-path" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} disabled={busy || !ready} /><button type="button" className="setup-outline" onClick={() => void browse()} disabled={busy || !ready}><FolderOpen size={16} />{copy.browse}</button></div>
        <button type="button" className="setup-primary" onClick={() => void open(workspacePath)} disabled={busy || !ready || !workspacePath.trim()}>{busy ? <LoaderCircle size={16} className="setup-spin" /> : <FolderOpen size={16} />}{copy.open}</button>
        {Boolean(setup?.recent.length) && <div className="setup-recent"><h3>{copy.recent}</h3>{setup?.recent.map((path) => <button type="button" key={path} title={path} disabled={busy || !ready} onClick={() => void open(path)}><FolderOpen size={16} /><span><b>{path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}</b><small>{path}</small></span></button>)}</div>}
      </section>
      {error && <p className="setup-error" role="alert">{error}</p>}
    </main>
  </div>;
}
