import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import { request, type FileEntry } from "./api";

interface Props { selected: string | null; onOpen(path: string): void }

export function FileTree({ selected, onOpen }: Props) {
  const [directories, setDirectories] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load(path: string) {
    setLoading(true);
    try {
      const data = await request<{ entries: FileEntry[] }>(`/api/v1/files?path=${encodeURIComponent(path)}`);
      setDirectories((current) => ({ ...current, [path]: data.entries }));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文件列表加载失败");
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(""); }, []);
  useEffect(() => {
    if (!showSearch || search.trim().length < 2) { setSearchResults([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void request<{ entries: FileEntry[] }>(`/api/v1/files/search?q=${encodeURIComponent(search.trim())}`)
        .then((data) => { if (!cancelled) { setSearchResults(data.entries); setError(""); } })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "搜索失败"); });
    }, 220);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [search, showSearch]);

  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!directories[path]) void load(path);
  }

  function renderDirectory(path: string, depth: number) {
    return (directories[path] ?? []).map((entry) => (
      <div key={entry.path}>
        <button
          type="button" className={`tree-row ${selected === entry.path ? "selected" : ""}`}
          style={{ paddingLeft: 12 + depth * 16 }} title={entry.path}
          onClick={() => entry.kind === "directory" ? toggle(entry.path) : onOpen(entry.path)}
        >
          {entry.kind === "directory" ? (
            <>
              {expanded.has(entry.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {expanded.has(entry.path) ? <FolderOpen size={16} className="folder-icon" /> : <Folder size={16} className="folder-icon" />}
            </>
          ) : (
            <><span className="tree-spacer" />{entry.name.match(/\.(ts|tsx|js|jsx|json)$/) ? <FileCode2 size={16} /> : <FileText size={16} />}</>
          )}
          <span className="truncate">{entry.name}</span>
        </button>
        {entry.kind === "directory" && expanded.has(entry.path) && renderDirectory(entry.path, depth + 1)}
      </div>
    ));
  }

  return (
    <section className="file-tree-section">
      <div className="sidebar-section-title">
        <strong>文件</strong>
        <div className="inline-actions">
          <button className="icon-button" title="搜索文件" aria-label="搜索文件" onClick={() => setShowSearch((value) => !value)}><Search size={16} /></button>
          <button className="icon-button" title="刷新文件树" aria-label="刷新文件树" onClick={() => { setDirectories({}); void load(""); }}><RefreshCw size={16} /></button>
        </div>
      </div>
      {showSearch && <div className="tree-search"><Search size={14} /><input autoFocus placeholder="搜索工作区文件" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="plain-icon" title="关闭搜索" aria-label="关闭搜索" onClick={() => { setShowSearch(false); setSearch(""); }}><X size={14} /></button></div>}
      {error && <p className="inline-error">{error}</p>}
      {loading && !directories[""] && <p className="muted small-pad">正在读取文件...</p>}
      <div className="tree-scroll" role="tree">{showSearch && search.trim().length >= 2 ? searchResults.map((entry) => <button key={entry.path} className="tree-row search-result" title={entry.path} onClick={() => entry.kind === "directory" ? toggle(entry.path) : onOpen(entry.path)}>{entry.kind === "directory" ? <Folder size={16} className="folder-icon" /> : <FileText size={16} />}<span className="truncate">{entry.path}</span></button>) : renderDirectory("", 0)}</div>
    </section>
  );
}
