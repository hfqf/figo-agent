import { useEffect, useState, type MouseEvent } from "react";
import { Code2, Eye, FolderTree, Plus } from "lucide-react";
import ReactMarkdown from "react-markdown";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import "highlight.js/styles/github.css";
import type { FilePreview, FileReference } from "./api";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("markdown", markdown);

interface Props { preview: FilePreview; onReference(reference: FileReference): void }

export function FilePreviewPane({ preview, onReference }: Props) {
  const [selectedLines, setSelectedLines] = useState<[number, number] | null>(null);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"source" | "preview">("source");
  const isMarkdown = /\.mdx?$/i.test(preview.path);
  useEffect(() => { setSelectedLines(null); setSearch(""); setMode("source"); }, [preview.path, preview.version]);

  function selectLine(line: number, event: MouseEvent<HTMLButtonElement>) {
    setSelectedLines((current) => event.shiftKey && current ? [Math.min(current[0], line), Math.max(current[0], line)] : [line, line]);
  }

  function reference() {
    if (!preview.version || !selectedLines) return;
    onReference({ path: preview.path, startLine: selectedLines[0], endLine: selectedLines[1], version: preview.version });
  }

  const language = languageFor(preview.path);
  return <div className="preview-area">
    <div className="preview-toolbar">
      <div className="preview-breadcrumb"><FolderTree size={15} /><span className="truncate" title={preview.path}>{preview.path}</span></div>
      {isMarkdown && <div className="preview-mode segmented" role="group" aria-label="Markdown 查看方式"><button className={mode === "source" ? "selected" : ""} title="查看源码" onClick={() => setMode("source")}><Code2 size={14} /></button><button className={mode === "preview" ? "selected" : ""} title="预览 Markdown" onClick={() => setMode("preview")}><Eye size={14} /></button></div>}
      {mode === "source" && <label className="preview-search"><input placeholder="在文件中搜索" value={search} onChange={(event) => setSearch(event.target.value)} /></label>}
      <button className="primary-button compact" onClick={reference} disabled={!selectedLines || !preview.version} title="引用选中行"><Plus size={15} />引用选中行</button>
    </div>
    {preview.tooLarge ? <div className="preview-code"><div className="preview-empty">文件超过 1 MB，首期不提供原文预览。</div></div> : mode === "preview" ?
      <div className="markdown-preview"><ReactMarkdown skipHtml>{preview.content ?? ""}</ReactMarkdown></div> :
      <div className="preview-code">{preview.content?.split("\n").map((line, index) => {
        const number = index + 1;
        const selected = selectedLines && number >= selectedLines[0] && number <= selectedLines[1];
        const highlighted = language && line ? hljs.highlight(line, { language, ignoreIllegals: true }).value : null;
        return <button className={`code-line ${selected ? "selected" : ""} ${search && line.toLowerCase().includes(search.toLowerCase()) ? "search-hit" : ""}`} key={number} onClick={(event) => selectLine(number, event)}><span className="line-number">{number}</span><code>{highlighted ? <span dangerouslySetInnerHTML={{ __html: highlighted }} /> : line || " "}</code></button>;
      })}</div>}
    <div className="preview-status">{preview.lineCount} 行 · {formatBytes(preview.size)}{selectedLines && ` · 已选 L${selectedLines[0]}–L${selectedLines[1]}`}</div>
  </div>;
}

function languageFor(path: string): string | null {
  const ext = path.split(".").at(-1)?.toLowerCase();
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", sh: "bash", bash: "bash", md: "markdown", mdx: "markdown" } as Record<string, string>)[ext ?? ""] ?? null;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
