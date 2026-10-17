import { useState, type ReactNode } from "react";
import { Clipboard, Download, ChevronDown, ChevronUp } from "lucide-react";
import type {
  ObservedNumber,
  TraceInspectorDetail,
  InspectorJson,
} from "../../src/contracts/trace-inspector";
import { inspectorCopy as c } from "./i18n";
import { isInspectorField, jsonText, redact, type InspectorField } from "./trace-inspector-state";
import { FieldPreview, fieldIdentity } from "./TraceInspectorField";
export function IconButton({
  label,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="ti-icon"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function observed(value?: ObservedNumber | null): string {
  if (!value || value.value === null || value.availability === "unavailable")
    return c.unknown;
  return `${value.value.toLocaleString()} · ${{ provider_actual: c.actual, estimate: c.estimate, usage_plus_estimate: c.mixed, count: c.count, unknown: c.unknown }[value.kind]}`;
}
export function downloadEvidence(text: string, name: string, markdown = false) {
  const url = URL.createObjectURL(
    new Blob([text], {
      type: markdown
        ? "text/markdown;charset=utf-8"
        : "application/json;charset=utf-8",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name.replace(/[/\\:*?"<>|]/g, "_");
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function JsonView({
  value,
  label,
  filename = "trace-inspector.json",
  exportScope,
}: {
  value: unknown;
  label: string;
  filename?: string;
  exportScope?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [loadedFields, setLoadedFields] = useState<Record<string, string>>({});
  const fields = new Map<string, InspectorField>();
  function display(item: unknown): unknown {
    if (isInspectorField(item)) {
      const id = fieldIdentity(item);
      fields.set(id, item);
      return loadedFields[id] ?? `[${c.fieldPreview} · ${item.originalChars} ${c.fieldChars}] ${item.preview}`;
    }
    if (Array.isArray(item)) return item.map(display);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, display(child)]));
    return item;
  }
  const displayed = display(value);
  const text = jsonText(displayed);
  const evidenceText = exportScope ? jsonText({ scope: exportScope, data: displayed }) : text;
  const lines = text.split("\n");
  const matches = query
    ? lines.filter((line) =>
        line.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      )
    : lines;
  const preview = expanded ? matches : matches.slice(0, 48);
  const rendered = expanded
    ? preview.join("\n")
    : preview.join("\n").slice(0, 24000);
  return (
    <section className="ti-json">
      <div className="ti-section-heading">
        <strong>{label}</strong>
        <span className="ti-spacer" />
        <IconButton
          label={c.copy}
          onClick={() => {
            void navigator.clipboard.writeText(evidenceText).then(
              () => setNotice(c.copied),
              () => setNotice(c.copyFailed),
            );
          }}
        >
          <Clipboard size={14} />
        </IconButton>
        <IconButton
          label={c.exportJson}
          onClick={() => downloadEvidence(evidenceText, filename)}
        >
          <Download size={14} />
        </IconButton>
      </div>
      {exportScope && <p className="ti-limitation">{exportScope}</p>}
      <input
        aria-label={c.jsonSearch}
        placeholder={c.jsonSearch}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <pre tabIndex={0}>{rendered || c.noMatch}</pre>
      {[...fields].map(([id, field]) => <FieldPreview key={id} value={field}
        onContent={(content) => setLoadedFields((old) => ({ ...old, [id]: content }))} />)}
      {fields.size > 0 && <small>{c.fieldScope}</small>}
      {(matches.length > 48 || matches.join("\n").length > 24000) && (
        <button
          className="ti-link"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? c.collapse : c.expand}
        </button>
      )}
      {notice && <small role="status">{notice}</small>}
    </section>
  );
}
export function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="ti-section" id={id}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function containsField(value: unknown): boolean {
  return isInspectorField(value) || (Array.isArray(value) ? value.some(containsField)
    : !!value && typeof value === "object" && Object.values(value).some(containsField));
}
export function Facts({ items }: { items: Array<[string, unknown]> }) {
  return (
    <dl className="ti-facts">
      {items.map(([label, value], index) => (
        <div key={`${label}-${index}`}>
          <dt>{label}</dt>
          <dd>
            {value === null || value === undefined || value === ""
              ? c.notRecorded
              : isInspectorField(value)
                ? <FieldPreview value={value} />
              : containsField(value)
                ? <JsonView label={label} value={value} />
              : typeof value === "object"
                ? jsonText(value)
                : String(redact(value))}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function object(value: unknown): Record<string, InspectorJson> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, InspectorJson>)
    : {};
}
export function field(
  value: Record<string, InspectorJson>,
  ...keys: string[]
): InspectorJson | undefined {
  for (const key of keys) if (value[key] !== undefined) return value[key];
}
export function relation(value: string) {
  return (
    (
      {
        direct: c.direct,
        scope_only: c.scope_only,
        unknown: c.unknown,
        selected: c.selected,
        recorded: c.recorded,
      } as Record<string, string>
    )[value] ?? value
  );
}
export function MessageList({ messages }: { messages: InspectorJson[] }) {
  const [role, setRole] = useState("");
  return (
    <>
      <select
        aria-label={c.role}
        value={role}
        onChange={(event) => setRole(event.target.value)}
      >
        <option value="">{c.allRoles}</option>
        {[
          ...new Set(
            messages.map((message) =>
              String(object(message).role ?? c.unknown),
            ),
          ),
        ].map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      {messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => !role || object(message).role === role)
        .map(({ message, index }) => (
          <details
            className="ti-message"
            key={index}
            open={messages.length < 4}
          >
            <summary>
              <span>{index + 1}</span>
              <b>{String(object(message).role ?? c.unknown)}</b>
            </summary>
            <JsonView label={c.actualMessages} value={message} />
          </details>
        ))}
    </>
  );
}
export function Timeline({
  detail,
  compaction = false,
}: {
  detail: TraceInspectorDetail;
  compaction?: boolean;
}) {
  const events = compaction
    ? detail.events.filter((event) => event.type.includes("compaction"))
    : detail.events;
  return (
    <ol className="ti-timeline">
      {events.map((event) => (
        <li key={event.id}>
          <time>{event.createdAt}</time>
          <b>{event.type}</b>
          <small>{relation(event.relation)}</small>
          <details>
            <summary>{c.metadata}</summary>
            <JsonView label={event.id} value={event.payload} />
          </details>
        </li>
      ))}
    </ol>
  );
}
