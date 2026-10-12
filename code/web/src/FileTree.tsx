import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import { request, type FileEntry } from "./api";
import { copy, formatCopy } from "./i18n";

interface Props { selected: string | null; onOpen(path: string): void; searchMinChars: number; searchMaxChars: number; maxDirectoryEntries: number }

export function FileTree({ selected, onOpen, searchMinChars, searchMaxChars, maxDirectoryEntries }: Props) {
  const [directories, setDirectories] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [truncatedPaths, setTruncatedPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load(path: string) {
    setLoading(true);
    try {
      const data = await request<{ entries: FileEntry[]; truncated: boolean }>(`/api/v1/files?path=${encodeURIComponent(path)}`);
      setDirectories((current) => ({ ...current, [path]: data.entries }));
      setTruncatedPaths((current) => { const next = new Set(current); if (data.truncated) next.add(path); else next.delete(path); return next; });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.fileListLoadFailed);
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(""); }, []);
  useEffect(() => {
    if (!showSearch || search.trim().length < searchMinChars) { setSearchResults([]); setSearchTruncated(false); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void request<{ entries: FileEntry[]; truncated: boolean }>(`/api/v1/files/search?q=${encodeURIComponent(search.trim())}`)
        .then((data) => { if (!cancelled) { setSearchResults(data.entries); setSearchTruncated(data.truncated); setError(""); } })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : copy.fileSearchFailed); });
    }, 220);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [search, showSearch, searchMinChars]);

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
        {entry.kind === "directory" && expanded.has(entry.path) && <>
          {truncatedPaths.has(entry.path) && <p className="file-list-notice">{formatCopy(copy.directoryIncomplete, { count: maxDirectoryEntries })}</p>}
          {renderDirectory(entry.path, depth + 1)}
        </>}
      </div>
    ));
  }

  return (
    <section className="file-tree-section">
      <div className="sidebar-section-title">
        <strong>{copy.files}</strong>
        <div className="inline-actions">
          <button className="icon-button" title={copy.searchFiles} aria-label={copy.searchFiles} onClick={() => setShowSearch((value) => !value)}><Search size={16} /></button>
          <button className="icon-button" title={copy.refreshFileTree} aria-label={copy.refreshFileTree} onClick={() => { setDirectories({}); void load(""); }}><RefreshCw size={16} /></button>
        </div>
      </div>
      {showSearch && <div className="tree-search"><Search size={14} /><input autoFocus placeholder={copy.searchWorkspaceFiles} maxLength={searchMaxChars} value={search} onChange={(event) => setSearch(event.target.value)} /><button className="plain-icon" title={copy.closeSearch} aria-label={copy.closeSearch} onClick={() => { setShowSearch(false); setSearch(""); }}><X size={14} /></button></div>}
      {error && <p className="inline-error">{error}</p>}
      {showSearch && searchTruncated && <p className="file-list-notice">{copy.searchIncomplete}</p>}
      {!showSearch && truncatedPaths.has("") && <p className="file-list-notice">{formatCopy(copy.rootDirectoryIncomplete, { count: maxDirectoryEntries })}</p>}
      {loading && !directories[""] && <p className="muted small-pad">{copy.fileLoading}</p>}
      <div className="tree-scroll" role="tree">{showSearch && search.trim().length >= searchMinChars ? searchResults.map((entry) => <button key={entry.path} className="tree-row search-result" title={entry.path} onClick={() => entry.kind === "directory" ? toggle(entry.path) : onOpen(entry.path)}>{entry.kind === "directory" ? <Folder size={16} className="folder-icon" /> : <FileText size={16} />}<span className="truncate">{entry.path}</span></button>) : renderDirectory("", 0)}</div>
    </section>
  );
}
