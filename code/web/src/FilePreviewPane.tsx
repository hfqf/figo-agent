import { useEffect, useRef, useState } from "react";
import { Code2, Eye, FolderTree, RotateCcw, Save, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import type { FilePreview, FileReference } from "./api";
import { copy, formatCopy } from "./i18n";

interface Props {
  preview: FilePreview;
  maxPreviewBytes: number;
  csrf: string;
  onSaved(preview: FilePreview): void;
  onDirtyChange(dirty: boolean): void;
  onReference(reference: FileReference): void;
  onClose(): void;
}

export function FilePreviewPane({ preview, maxPreviewBytes, csrf, onSaved, onDirtyChange, onReference, onClose }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const saveAction = useRef<() => void>(() => {});
  const [draft, setDraft] = useState(preview.content ?? "");
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"source" | "preview">("source");
  const isMarkdown = /\.mdx?$/i.test(preview.path);
  const dirty = draft !== (preview.content ?? "");

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  useEffect(() => {
    setDraft(preview.content ?? ""); setSelection(null); setError(""); setMode("source");
  }, [preview.path, preview.version]);
  useEffect(() => {
    if (!host.current || preview.content === null || mode !== "source") return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: draft,
        extensions: [basicSetup, languageFor(preview.path), EditorView.editable.of(!saving),
          EditorView.cspNonce.of(document.querySelector('meta[name="figo-csp-nonce"]')?.getAttribute("content") ?? ""),
          keymap.of([{ key: "Mod-s", run: () => { saveAction.current(); return true; } }]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setDraft(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const range = update.state.selection.main;
              setSelection([update.state.doc.lineAt(range.from).number, update.state.doc.lineAt(range.to).number]);
            }
          })]
      })
    });
    return () => view.destroy();
  }, [preview.path, preview.version, mode, saving]);

  async function save() {
    if (!dirty || saving || !preview.version) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/v1/file", {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Figo-CSRF": csrf },
        body: JSON.stringify({ path: preview.path, content: draft, version: preview.version })
      });
      const result = await response.json() as FilePreview & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      onSaved(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.saveFailed); }
    finally { setSaving(false); }
  }
  saveAction.current = () => { void save(); };

  function reference() {
    if (!preview.version || !selection || dirty) return;
    onReference({ path: preview.path, startLine: selection[0], endLine: selection[1], version: preview.version });
  }

  return <div className="preview-area">
    <div className="preview-toolbar">
      <div className="preview-breadcrumb"><FolderTree size={15} /><span className="truncate" title={preview.path}>{preview.path}</span>{dirty && <span className="dirty-dot" title={copy.unsaved} />}</div>
      {isMarkdown && <div className="preview-mode segmented" role="group" aria-label={copy.markdownViewMode}><button className={mode === "source" ? "selected" : ""} title={copy.editSource} onClick={() => setMode("source")}><Code2 size={14} /></button><button className={mode === "preview" ? "selected" : ""} title={copy.previewMarkdown} onClick={() => setMode("preview")}><Eye size={14} /></button></div>}
      <button className="icon-button" title={copy.referenceSelectedLines} aria-label={copy.referenceSelectedLines} onClick={reference} disabled={!selection || dirty || !preview.version}><Code2 size={15} /></button>
      <button className="primary-button compact" title={copy.saveFile} onClick={() => void save()} disabled={!dirty || saving || preview.tooLarge}><Save size={15} />{copy.save}</button>
      <button className="icon-button" title={copy.closeFile} aria-label={copy.closeFile} onClick={onClose} disabled={saving}><X size={15} /></button>
    </div>
    {error && <div className="editor-error"><span>{error}</span><button className="outline-button" onClick={onClose}><RotateCcw size={13} />{copy.closeFile}</button></div>}
    {preview.tooLarge ? <div className="preview-code"><div className="preview-empty">{formatCopy(copy.fileTooLarge, { size: formatBytes(maxPreviewBytes) })}</div></div> : mode === "preview" ?
      <div className="markdown-preview"><ReactMarkdown skipHtml>{draft}</ReactMarkdown></div> :
      <div className="preview-code editor-host" ref={host} />}
    <div className="preview-status">{formatCopy(copy.fileLineCount, { count: draft.split("\n").length })} · {formatBytes(new TextEncoder().encode(draft).length)}{selection && ` · L${selection[0]}–L${selection[1]}`}{dirty && ` · ${copy.unsaved}`}</div>
  </div>;
}

function languageFor(path: string) {
  const ext = path.split(".").at(-1)?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext ?? "")) return javascript({ typescript: ext === "ts" || ext === "tsx", jsx: ext === "tsx" || ext === "jsx" });
  if (ext === "json") return json();
  if (ext === "md" || ext === "mdx") return markdown();
  if (ext === "css") return css();
  if (ext === "html") return html();
  return [];
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
