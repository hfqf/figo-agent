import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { TraceInspectorEventPage } from "../../src/contracts/trace-inspector";
import { IconButton } from "./TraceInspectorPrimitives";
import { formatCopy, inspectorCopy as c } from "./i18n";

interface Props {
  pagination?: TraceInspectorEventPage["pagination"];
  live: boolean;
  loaded: number;
  loading: boolean;
  onPage(page: number): void;
  onHistoryStart(): void;
}
export function TraceInspectorPagination({ pagination: p, live, loaded, loading, onPage, onHistoryStart }: Props) {
  const page = p?.page ?? 0;
  const pages = p?.totalPages ?? 0;
  return <nav className="ti-pagination" aria-label={c.pagination}>
    <div className="ti-page-stats" aria-live="polite">
      <strong>{p ? formatCopy(c.totalRecords, { count: p.totalCount }) : loading ? c.loading : c.paginationUnknown}</strong>
      {live ? <><span>{c.liveWindow}</span><span>{formatCopy(c.latestRecords, { count: loaded })}</span></> : p && p.page !== null ? <>
        <span>{formatCopy(c.pagePosition, { page, pages })}</span>
        <span>{formatCopy(c.pageRange, { from: p.from ?? 0, to: p.to ?? 0 })}</span>
        <span>{formatCopy(c.pageSize, { size: p.pageSize })}</span>
      </> : <span>{formatCopy(c.loadedRecords, { count: loaded })}</span>}
    </div>
    <div className="ti-page-actions">
      {loading && <small role="status">{c.loading}</small>}
      {live ? <button onClick={onHistoryStart} disabled={loading}>{c.historyStart}</button> : <>
        <IconButton label={c.firstPage} disabled={loading || page <= 1} onClick={() => onPage(1)}><ChevronsLeft size={15} /></IconButton>
        <IconButton label={c.previousPage} disabled={loading || page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={15} /></IconButton>
        <IconButton label={c.nextPage} disabled={loading || !page || page >= pages} onClick={() => onPage(page + 1)}><ChevronRight size={15} /></IconButton>
        <IconButton label={c.lastPage} disabled={loading || !page || page >= pages} onClick={() => onPage(pages)}><ChevronsRight size={15} /></IconButton>
      </>}
    </div>
  </nav>;
}
