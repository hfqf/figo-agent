import { useEffect, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { request, type FilePreview } from "./api";
import { inspectorCopy as c } from "./i18n";
import {
  fileReferencePath,
  redact,
  snapshotDifference,
} from "./trace-inspector-state";
import { IconButton, JsonView } from "./TraceInspectorDetails";

interface Props {
  source: string;
  snapshot: unknown;
  file: boolean;
  truncated: boolean;
  onClose(): void;
}
/** 当前文件通过只读 API 独立读取，不覆盖历史快照，也不触碰工作台文件草稿。 */
export function TraceInspectorSource({
  source,
  snapshot,
  file,
  truncated,
  onClose,
}: Props) {
  const [current, setCurrent] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!current || !file) return;
    let cancelled = false;
    setError("");
    void request<FilePreview>(
      `/api/v1/trace-inspector/file?path=${encodeURIComponent(fileReferencePath(source))}`,
    )
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : c.loadFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [source, current, file, retry]);
  const item =
    snapshot && typeof snapshot === "object"
      ? (snapshot as Record<string, unknown>)
      : null;
  const difference =
    !truncated &&
    typeof item?.content === "string" &&
    preview &&
    !preview.tooLarge
      ? snapshotDifference(source, item.content, preview.content)
      : null;
  return (
    <div className="ti-source-backdrop" onClick={onClose}>
      <section
        className="ti-source-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={c.snapshot}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ti-section-heading">
          <strong>{current ? c.currentFileNote : c.snapshot}</strong>
          <IconButton label={c.close} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <p>{source}</p>
        <div className="ti-source-modes">
          <button aria-pressed={!current} onClick={() => setCurrent(false)}>
            {c.snapshot}
          </button>
          {file && (
            <button aria-pressed={current} onClick={() => setCurrent(true)}>
              <ExternalLink size={14} />
              {c.openFile}
            </button>
          )}
        </div>
        {!current ? (
          snapshot ? (
            <JsonView label={c.snapshot} value={snapshot} />
          ) : (
            <p>{truncated ? c.truncated : c.sourceMissing}</p>
          )
        ) : (
          <>
            {error && (
              <div className="ti-error" role="alert">
                <span>{error}</span>
                <button onClick={() => setRetry((value) => value + 1)}>
                  {c.retry}
                </button>
              </div>
            )}
            {preview ? (
              <>
                <p>
                  {c.fileVersion} · {preview.version ?? c.unknown}
                </p>
                <p
                  className={
                    difference === true ? "ti-warning" : "ti-limitation"
                  }
                >
                  {difference === null
                    ? c.versionUnknown
                    : difference
                      ? c.fileDifferent
                      : c.fileSame}
                </p>
                {preview.tooLarge && (
                  <p className="ti-warning">{c.truncated}</p>
                )}
                <pre className="ti-file-current">
                  {preview.content === null
                    ? c.notRecorded
                    : String(redact(preview.content))}
                </pre>
              </>
            ) : (
              <p>{c.loading}</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
