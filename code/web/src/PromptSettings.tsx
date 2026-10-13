import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Save } from "lucide-react";
import { request } from "./api";
import { copy } from "./i18n";

interface PromptConfig { systemInstruction: string; userInstruction: string }
interface VersionedPrompts { prompts: PromptConfig; version: string }

export function PromptSettings({ csrf, onDirtyChange }: { csrf: string; onDirtyChange?(dirty: boolean): void }) {
  const [saved, setSaved] = useState<VersionedPrompts | null>(null);
  const [prompts, setPrompts] = useState<PromptConfig>({ systemInstruction: "", userInstruction: "" });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const dirty = Boolean(saved && (saved.prompts.systemInstruction !== prompts.systemInstruction || saved.prompts.userInstruction !== prompts.userInstruction));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    void request<VersionedPrompts>("/api/v1/settings/prompts")
      .then((value) => { if (!cancelled) { setSaved(value); setPrompts(value.prompts); } })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : copy.promptLoadFailed); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);

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

  return <form className="settings-form prompt-settings-form" onSubmit={(event) => void save(event)}>
      <h2>{copy.promptSettingsTitle}</h2>
      <div className="prompt-setting-field">
        <label htmlFor="system-instruction">{copy.customSystemInstruction}</label>
        <p id="system-instruction-help">{copy.systemInstructionHelp}</p>
        <textarea id="system-instruction" aria-describedby="system-instruction-help" placeholder={copy.systemInstructionPlaceholder} value={prompts.systemInstruction} maxLength={16000} disabled={busy || !saved} onChange={(event) => setPrompts((current) => ({ ...current, systemInstruction: event.target.value }))} />
      </div>
      <div className="prompt-setting-field">
        <label htmlFor="user-instruction">{copy.persistentUserInstruction}</label>
        <p id="user-instruction-help">{copy.userInstructionHelp}</p>
        <textarea id="user-instruction" aria-describedby="user-instruction-help" placeholder={copy.userInstructionPlaceholder} value={prompts.userInstruction} maxLength={16000} disabled={busy || !saved} onChange={(event) => setPrompts((current) => ({ ...current, userInstruction: event.target.value }))} />
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="settings-actions"><button type="submit" className="primary-button" disabled={!dirty || busy}>{busy ? <LoaderCircle size={15} className="spinning" /> : <Save size={15} />}{busy ? copy.loading : copy.save}</button></div>
    </form>;
}
