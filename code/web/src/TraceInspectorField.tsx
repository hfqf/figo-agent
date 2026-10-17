import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { request } from "./api";
import { inspectorCopy as c } from "./i18n";
import { InspectorRequestGate, inspectorFieldPath, redact, type InspectorField } from "./trace-inspector-state";
import type { InspectorFieldPage } from "../../src/contracts/trace-inspector-field";
export function fieldIdentity(field: InspectorField): string {
  return JSON.stringify([field.eventKey, field.field, field.path, field.originalChars, field.preview, field.loadable]);
}
export function FieldPreview(props: { value: InspectorField; onContent?(content: string): void }) {
  return <FieldSession key={fieldIdentity(props.value)} {...props} />;
}
function FieldSession({ value, onContent }: { value: InspectorField; onContent?(content: string): void }) {
  const [loaded, setLoaded] = useState<{ content: string; next: number | null; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const gate = useRef(new InspectorRequestGate());
  const busy = useRef(false);
  useEffect(() => {
    gate.current.begin();
    return () => { gate.current.begin(); };
  }, []);
  async function load() {
    if (busy.current || !value.loadable || loaded?.next === null) return;
    busy.current = true;
    const ticket = gate.current.begin();
    setLoading(true);
    setError("");
    const offset = loaded?.next ?? 0;
    try {
      const page = await request<InspectorFieldPage>(inspectorFieldPath(value, offset));
      if (!gate.current.current(ticket)) return;
      if (page.eventKey !== value.eventKey || page.field !== value.field || JSON.stringify(page.path) !== JSON.stringify(value.path)
        || page.offset !== offset || typeof page.content !== "string" || !["text", "json"].includes(page.format)
        || !Number.isSafeInteger(page.totalChars) || page.totalChars < offset + page.content.length
        || typeof page.complete !== "boolean" || page.complete !== (page.nextOffset === null)
        || (page.complete && page.totalChars !== offset + page.content.length)
        || (page.nextOffset !== null && (page.nextOffset !== offset + page.content.length || page.nextOffset <= offset))) {
        throw new Error(c.fieldInvalidResponse);
      }
      const content = (loaded?.content ?? "") + page.content;
      setLoaded({ content, next: page.nextOffset, total: page.totalChars });
      onContent?.(content);
    } catch (reason) {
      if (gate.current.current(ticket)) setError(reason instanceof Error ? reason.message : c.loadFailed);
    } finally {
      if (gate.current.current(ticket)) {
        setLoading(false);
        busy.current = false;
      }
    }
  }
  return <section className="ti-field" data-field={value.field}>
    <div className="ti-section-heading">
      <strong>{c.fieldPreview}</strong>
      <code>{value.field}{value.path.length ? ` · ${JSON.stringify(value.path)}` : ""}</code>
    </div>
    <small>{loaded ? `${c.fieldLoadedChars} ${loaded.content.length} / ${loaded.total}` : `${c.fieldOriginalChars} ${value.originalChars}`} {c.fieldChars}</small>
    <pre tabIndex={0}>{String(redact(loaded?.content ?? value.preview))}</pre>
    {!value.loadable ? <p>{c.fieldNotLoadable}</p> : loaded?.next === null ? <small role="status">{c.fieldLoaded}</small> :
      <button type="button" className="ti-link" onClick={() => void load()} disabled={loading}>
        {error ? <RefreshCw size={14} /> : <Download size={14} />}
        {loading ? c.loading : error ? c.retry : loaded ? c.loadMoreField : c.loadFullField}
      </button>}
    {error && <p role="alert" className="ti-error">{String(redact(error))}</p>}
  </section>;
}
