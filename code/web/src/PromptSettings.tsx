import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Save, Settings2, X } from "lucide-react";
import { request } from "./api";
import { copy } from "./i18n";

interface PromptConfig { systemInstruction: string; userInstruction: string }
interface VersionedPrompts { prompts: PromptConfig; version: string }

export function PromptSettings({ csrf, onClose }: { csrf: string; onClose(): void }) {
  const [saved, setSaved] = useState<VersionedPrompts | null>(null);
  const [prompts, setPrompts] = useState<PromptConfig>({ systemInstruction: "", userInstruction: "" });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const dirty = Boolean(saved && (saved.prompts.systemInstruction !== prompts.systemInstruction || saved.prompts.userInstruction !== prompts.userInstruction));

  useEffect(() => {
    let cancelled = false;
    void request<VersionedPrompts>("/api/v1/settings/prompts")
      .then((value) => { if (!cancelled) { setSaved(value); setPrompts(value.prompts); } })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : copy.promptLoadFailed); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);

  function close() {
    if (dirty && !window.confirm(copy.unsavedPromptConfirm)) return;
    onClose();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || !dirty || busy) return;
    setBusy(true); setError("");
    try {
      const value = await request<VersionedPrompts>("/api/v1/settings/prompts", {
        method: "PUT", csrf, body: { prompts, version: saved.version }
      });
      setSaved(value); setPrompts(value.prompts);
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.promptSaveFailed); }
    finally { setBusy(false); }
  }

  return <div className="dialog-backdrop" onClick={close}>
    <form className="task-dialog prompt-dialog" onClick={(event) => event.stopPropagation()} onSubmit={(event) => void save(event)}>
      <div className="dialog-title"><Settings2 size={19} /><strong>{copy.promptSettingsTitle}</strong><button className="plain-icon" type="button" title={copy.close} aria-label={copy.close} onClick={close}><X size={17} /></button></div>
      <label htmlFor="system-instruction">{copy.customSystemInstruction}</label>
      <textarea id="system-instruction" value={prompts.systemInstruction} maxLength={16000} disabled={busy || !saved} onChange={(event) => setPrompts((current) => ({ ...current, systemInstruction: event.target.value }))} />
      <label htmlFor="user-instruction">{copy.persistentUserInstruction}</label>
      <textarea id="user-instruction" value={prompts.userInstruction} maxLength={16000} disabled={busy || !saved} onChange={(event) => setPrompts((current) => ({ ...current, userInstruction: event.target.value }))} />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="outline-button" onClick={close}>{copy.cancel}</button><button type="submit" className="primary-button" disabled={!dirty || busy}>{busy ? <LoaderCircle size={15} className="spinning" /> : <Save size={15} />}{busy ? copy.loading : copy.save}</button></div>
    </form>
  </div>;
}
