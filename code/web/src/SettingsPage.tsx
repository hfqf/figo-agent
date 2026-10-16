import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, KeyRound, LoaderCircle, RefreshCw, Save, Trash2 } from "lucide-react";
import { request } from "./api";
import { copy } from "./i18n";
import { PromptSettings } from "./PromptSettings";

type Family = "minimax" | "deepseek" | "gpt-official" | "gpt-relay";
interface Model { id: string; family: Family; enabled: boolean; baseUrl: string; model: string; hasApiKey: boolean; apiKey?: string; clearApiKey?: boolean }
interface Snapshot { activeModelId: string; models: Model[]; version: string }
const defaults: Record<Family, { url: string; model: string }> = {
  minimax: { url: "https://api.minimaxi.com/v1", model: "MiniMax-M3" },
  deepseek: { url: "https://api.deepseek.com", model: "deepseek-flash" },
  "gpt-official": { url: "https://api.openai.com/v1", model: "" },
  "gpt-relay": { url: "", model: "" }
};
const families: Family[] = ["minimax", "deepseek", "gpt-official", "gpt-relay"];
const labels: Record<Family, string> = {
  minimax: copy.modelMiniMax, deepseek: copy.modelDeepSeek, "gpt-official": copy.modelGptOfficial, "gpt-relay": copy.modelGptRelay
};

export function SettingsPage({ csrf, onClose, onModelsSaved }: { csrf: string; onClose(): void; onModelsSaved(version: string): void }) {
  const [tab, setTab] = useState<"models" | "prompts">("models");
  const [saved, setSaved] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<Family>("minimax");
  const [modelLists, setModelLists] = useState<Partial<Record<Family, string[]>>>({});
  const [discovering, setDiscovering] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const modelDirty = Boolean(saved && draft && (saved.activeModelId !== draft.activeModelId || JSON.stringify(saved.models) !== JSON.stringify(draft.models)));
  const current: Model | undefined = draft?.models.find((model) => model.family === selected) ?? (draft ? { id: selected, family: selected, enabled: false, baseUrl: defaults[selected].url, model: "", hasApiKey: false } : undefined);
  const choices = current ? [...new Set([...(current.model ? [current.model] : []), ...(modelLists[selected] ?? [])])] : [];

  useEffect(() => {
    let cancelled = false;
    void request<Snapshot>("/api/v1/settings/models").then((value) => {
      if (!cancelled) { setSaved(value); setDraft(value); setSelected(value.models.find((model) => model.id === value.activeModelId)?.family ?? "minimax"); }
    }).catch((reason) => { if (!cancelled) setError(settingsError(reason, copy.modelLoadFailed)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);

  function leave() {
    if ((modelDirty || promptDirty) && !window.confirm(copy.unsavedSettingsConfirm)) return;
    onClose();
  }
  function changeTab(next: "models" | "prompts") {
    if (tab === "prompts" && promptDirty && !window.confirm(copy.unsavedSettingsConfirm)) return;
    setTab(next);
  }
  function edit(patch: Partial<Model>) {
    if (patch.apiKey !== undefined || patch.baseUrl !== undefined) {
      setModelLists((state) => ({ ...state, [selected]: undefined }));
      setCatalogError("");
    }
    setDraft((state) => state && ({ ...state, models: state.models.some((model) => model.family === selected)
      ? state.models.map((model) => model.family === selected ? { ...model, ...patch } : model)
      : [...state.models, { id: selected, family: selected, enabled: false, baseUrl: defaults[selected].url, model: "", hasApiKey: false, ...patch }] }));
    setNotice("");
  }
  function remove() {
    if (!draft || !current || current.id === draft.activeModelId) return;
    setDraft({ ...draft, models: draft.models.filter((model) => model.family !== selected) });
    setModelLists((state) => ({ ...state, [selected]: undefined }));
    setNotice("");
  }
  async function discover() {
    if (!current || discovering) return;
    setDiscovering(true); setCatalogError("");
    try {
      const result = await request<{ models: string[] }>("/api/v1/settings/models/discover", { method: "POST", csrf,
        body: { id: selected, baseUrl: current.baseUrl, apiKey: current.apiKey ?? "" } });
      setModelLists((state) => ({ ...state, [selected]: result.models }));
      if (!result.models.length) setCatalogError(copy.modelListEmpty);
    } catch (reason) { setCatalogError(reason instanceof Error ? reason.message : copy.modelListFailed); }
    finally { setDiscovering(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || !draft || !modelDirty || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await request<Snapshot>("/api/v1/settings/models", { method: "PUT", csrf, body: {
        version: saved.version, activeModelId: draft.activeModelId,
        models: draft.models.map(({ hasApiKey: _hasApiKey, ...model }) => model)
      } });
      setSaved(result); setDraft(result); setNotice(copy.modelSavedNotice);
      onModelsSaved(result.version);
    } catch (reason) { setError(settingsError(reason, copy.modelSaveFailed)); }
    finally { setBusy(false); }
  }
  const promptDirtyChanged = useCallback((dirty: boolean) => setPromptDirty(dirty), []);

  return <main className="settings-page">
    <div className="settings-heading"><button className="icon-button" title={copy.backToWorkbench} aria-label={copy.backToWorkbench} onClick={leave}><ArrowLeft size={18} /></button><h1>{copy.settingsTitle}</h1></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label={copy.settingsTitle}>
        <button className={tab === "models" ? "active" : ""} onClick={() => changeTab("models")}>{copy.modelSettingsTitle}</button>
        <button className={tab === "prompts" ? "active" : ""} onClick={() => changeTab("prompts")}>{copy.promptSettingsTitle}</button>
      </nav>
      <div className="settings-content">
        {tab === "prompts" ? <PromptSettings csrf={csrf} onDirtyChange={promptDirtyChanged} /> : <form className="settings-form" onSubmit={(event) => void save(event)}>
          <div className="settings-section-heading"><h2>{copy.modelSettingsTitle}</h2></div>
          {draft && <div className="model-settings-layout"><div className="model-settings-list" aria-label={copy.modelSettingsTitle}>
            {families.map((family) => { const model = draft.models.find((item) => item.family === family); return <button key={family} type="button" className={family === selected ? "selected" : ""} onClick={() => { setSelected(family); setCatalogError(""); }}>
              <span><b>{labels[family]}</b><small>{model?.model || copy.notConfigured}</small></span>
              {model?.id === draft.activeModelId && <em>{copy.currentModel}</em>}
            </button>; })}
          </div>
          {current && <div className="model-settings-editor" key={current.id}>
            <div className="model-editor-top"><strong>{labels[current.family]}</strong><button type="button" className="plain-icon" title={copy.deleteModel} aria-label={copy.deleteModel} onClick={remove} disabled={current.id === draft.activeModelId || !draft.models.some((model) => model.family === selected) || busy}><Trash2 size={17} /></button></div>
            <label htmlFor="model-url">{copy.modelBaseUrl}</label><input id="model-url" type="url" value={current.baseUrl} required disabled={busy || current.family !== "gpt-relay"} onChange={(event) => edit({ baseUrl: event.target.value, apiKey: "", hasApiKey: false })} />
            <label htmlFor="model-key">{copy.modelApiKey}</label><div className="settings-key-input"><KeyRound size={16} /><input id="model-key" type="password" autoComplete="new-password" value={current.apiKey ?? ""} disabled={busy || current.clearApiKey} onChange={(event) => edit({ apiKey: event.target.value })} placeholder={current.hasApiKey ? copy.modelKeyStored : copy.modelKeyEnter} /></div>
            {current.hasApiKey && <label className="settings-check"><input type="checkbox" checked={current.clearApiKey ?? false} disabled={busy} onChange={(event) => edit({ clearApiKey: event.target.checked, apiKey: "" })} />{copy.modelClearKey}</label>}
            <div className="model-catalog-heading"><label htmlFor="model-name">{copy.modelName}</label><button type="button" className="outline-button" onClick={() => void discover()} disabled={busy || discovering || (!current.apiKey && !current.hasApiKey) || !current.baseUrl}>{discovering ? <LoaderCircle size={15} className="spinning" /> : <RefreshCw size={15} />}{copy.modelListRefresh}</button></div>
            <select id="model-name" value={current.model} required disabled={busy || discovering} onChange={(event) => edit({ model: event.target.value })}>
              <option value="" disabled>{copy.modelChoose}</option>
              {choices.map((id) => <option value={id} key={id}>{id}{!modelLists[selected]?.includes(id) ? copy.modelSavedSuffix : ""}</option>)}
            </select>
            {catalogError && <p className="inline-error" role="alert">{catalogError}</p>}
            <div className="model-switches"><label className="settings-check"><input type="checkbox" checked={current.enabled} disabled={busy || current.id === draft.activeModelId} onChange={(event) => edit({ enabled: event.target.checked })} />{copy.modelEnabled}</label><label className="settings-check"><input type="radio" name="active-model" checked={current.id === draft.activeModelId} disabled={busy || !current.enabled} onChange={() => setDraft((state) => state && ({ ...state, activeModelId: current.id }))} />{copy.currentModel}</label></div>
          </div>}</div>}
          {error && <p className="inline-error" role="alert">{error}</p>}
          {notice && <p className="settings-notice" role="status">{notice}</p>}
          <div className="settings-actions"><button type="submit" className="primary-button" disabled={!modelDirty || busy}>{busy ? <LoaderCircle size={15} className="spinning" /> : <Save size={15} />}{busy ? copy.loading : copy.save}</button></div>
        </form>}
      </div>
    </div>
  </main>;
}

function settingsError(reason: unknown, fallback: string): string {
  if (reason instanceof Error && (reason.message === "接口不存在。" || reason.message === "HTTP 404")) return copy.modelServerOutdated;
  return reason instanceof Error ? reason.message : fallback;
}
