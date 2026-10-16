import {
  ArrowRight,
  Database,
  FileText,
  Layers,
  MessageSquare,
} from "lucide-react";
import type { DetailProps } from "./TraceInspectorDetails";
import {
  Facts,
  Section,
  JsonView,
  MessageList,
  Timeline,
  object,
  field,
  relation,
} from "./TraceInspectorPrimitives";
import { inspectorCopy as c } from "./i18n";

/** 构建层与请求层分开计数，导航箭头只表达观察顺序，证据状态另行显示。 */
export function ContextFlow({
  detail: d,
  requestId,
  compactionEntryId,
  onSource,
  onTool,
  onCompaction,
}: DetailProps) {
  const capture = requestId
    ? d.captures.find((item) => item.requestId === requestId)
    : undefined;
  const projection = d.selection.projection;
  const projectedEntry = projection.compactionEntryId
    ? d.compactions.find((item) => item.id === projection.compactionEntryId)
    : undefined;
  const selectedEntry = compactionEntryId
    ? d.compactions.find((item) => item.id === compactionEntryId)
    : undefined;
  const entry = projectedEntry;
  const body = object(capture?.requestBody);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const files = d.context.items.filter(
    (item) => field(item, "sourceType", "source_type") === "file_reference",
  );
  const memory = d.context.items.filter(
    (item) => field(item, "sourceType", "source_type") === "memory",
  );
  const projected = projection.status === "recorded";
  return (
    <>
      <nav className="ti-flow ti-flow-overview" aria-label={c.contextFlow}>
        <a className="ti-flow-stage" href="#ti-context-sources">
          <FileText size={18} />
          <b>{c.filesMemory}</b>
          <span>
            {c.fileReferences} · {d.context.pack ? files.length : c.unknown}
          </span>
          <span>
            {c.memoryRecords} · {d.context.pack ? memory.length : c.unknown}
          </span>
        </a>
        <ArrowRight size={15} aria-hidden="true" />
        <a className="ti-flow-stage" href="#ti-context-pack">
          <Database size={18} />
          <b>{c.contextPack}</b>
          <span>
            {c.recordedItems} ·{" "}
            {d.context.pack ? d.context.items.length : c.unknown}
          </span>
          <span title={String(d.context.pack?.id ?? "")}>
            {d.context.pack
              ? `${field(d.context.pack, "estimatedTokens", "estimated_tokens") ?? c.unknown} · ${c.estimate}`
              : c.unknown}
          </span>
        </a>
        <ArrowRight size={15} aria-hidden="true" />
        <a className="ti-flow-stage" href="#ti-context-projection">
          <Layers size={18} />
          <b>{c.summaryRetained}</b>
          <span>
            {c.summary} ·{" "}
            {projected
              ? projection.compactionEntryId || projection.legacyCheckpointId
                ? 1
                : 0
              : c.unknown}
          </span>
          <span>
            {c.retainedMessages} ·{" "}
            {projected ? projection.sourceRefs.length : c.unknown}
          </span>
        </a>
        <ArrowRight size={15} aria-hidden="true" />
        <a className="ti-flow-stage" href="#ti-context-request">
          <MessageSquare size={18} />
          <b>{c.llmRequest}</b>
          <span>
            {c.actualMessages} ·{" "}
            {capture && Array.isArray(body.messages)
              ? messages.length
              : c.unknown}
          </span>
          <span title={requestId ?? ""}>{requestId ?? c.selectRequest}</span>
        </a>
      </nav>
      <p className="ti-flow-evidence">
        {c.flowEvidence} · {projected ? c.recorded : c.sourceUnknown}
      </p>
      <Section id="ti-context-projection" title={c.projection}>
        <Facts
          items={[
            [c.requestId, requestId],
            [c.status, relation(projection.status)],
            [c.entry, projection.compactionEntryId],
            [c.legacy, projection.legacyCheckpointId],
          ]}
        />
        {!projected && <p className="ti-warning">{c.sourceUnknown}</p>}
        <div className="ti-source-refs">
          {projected &&
            projection.sourceRefs.map((ref, index) => (
              <button
                key={`${ref}-${index}`}
                className="ti-link"
                onClick={() => onSource(ref)}
              >
                {ref}
              </button>
            ))}
        </div>
      </Section>
      <Section id="ti-context-boundary" title={c.boundaries}>
        {entry ? (
          <>
            <Facts
              items={[
                [c.entry, entry.id],
                [c.covered, entry.coveredSourceRefs.length],
                [c.firstKept, entry.firstKeptSourceRef],
              ]}
            />
            <button
              className="ti-link"
              onClick={() => onSource(entry.firstKeptSourceRef)}
            >
              {c.firstKept} · {entry.firstKeptSourceRef}
            </button>
            {entry.baseEntryId && (
              <button
                className="ti-link"
                onClick={() => onCompaction(entry.baseEntryId!)}
              >
                {c.base} · {entry.baseEntryId}
              </button>
            )}
          </>
        ) : (
          <p className="ti-limitation">
            {projection.legacyCheckpointId
              ? c.legacyBoundary
              : c.boundaryUnknown}
          </p>
        )}
        {selectedEntry && selectedEntry.id !== entry?.id && (
          <p className="ti-limitation">
            {c.separateEntry} · {selectedEntry.id}
          </p>
        )}
        <a className="ti-link" href="#ti-context-messages">
          {c.messages}
          <ArrowRight size={14} />
        </a>
      </Section>
      <Section id="ti-context-sources" title={c.contextItems}>
        <div className="ti-table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  c.source,
                  c.ref,
                  c.reason,
                  c.estimate,
                  c.included,
                  c.snapshot,
                ].map((name) => (
                  <th key={name}>{name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.context.items.map((item, index) => {
                const ref = String(
                  field(item, "sourceRef", "source_ref") ?? "",
                );
                return (
                  <tr key={String(item.id ?? index)}>
                    <td>
                      {String(
                        field(item, "sourceType", "source_type") ?? c.unknown,
                      )}
                    </td>
                    <td className="ti-wrap">
                      <button className="ti-link" onClick={() => onSource(ref)}>
                        {ref}
                      </button>
                    </td>
                    <td>{String(item.reason ?? c.notRecorded)}</td>
                    <td>
                      {String(
                        field(item, "estimatedTokens", "estimated_tokens") ??
                          c.unknown,
                      )}{" "}
                      · {c.estimate}
                    </td>
                    <td>
                      {item.included === true || item.included === 1
                        ? c.yes
                        : c.no}
                    </td>
                    <td>
                      <button className="ti-link" onClick={() => onSource(ref)}>
                        {c.snapshot}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
      <Section id="ti-context-request" title={c.actualMessages}>
        {!requestId ? (
          <p>{c.selectRequest}</p>
        ) : capture ? (
          <MessageList key={requestId} messages={messages} />
        ) : (
          <p>{c.noCapture}</p>
        )}
      </Section>
      <Section id="ti-context-messages" title={c.messages}>
        {!d.messages.length && <p>{c.noMessages}</p>}
        {d.messages.map((message, index) => (
          <div
            key={`${message.sourceRef}-${index}`}
            className={
              entry?.firstKeptSourceRef === message.sourceRef ? "ti-cut" : ""
            }
          >
            {entry?.firstKeptSourceRef === message.sourceRef && (
              <b>{c.firstKept}</b>
            )}
            <details>
              <summary>
                <span>{message.turnId}</span>
                <button
                  className="ti-link"
                  onClick={(event) => {
                    event.preventDefault();
                    onSource(message.sourceRef);
                  }}
                >
                  {message.sourceRef}
                </button>
                <span>
                  {message.state === "raw"
                    ? c.rawState
                    : message.state === "covered"
                      ? c.coveredState
                      : c.sourceUnknown}
                </span>
              </summary>
              <Facts
                items={[
                  [
                    c.stateScope,
                    message.stateScope === "selected_request"
                      ? c.selected_request
                      : c.current_record,
                  ],
                  [c.currentOmitted, message.omitted ? c.yes : c.no],
                  [c.relation, relation(message.relation)],
                ]}
              />
              <JsonView label={c.snapshot} value={message.message} />
              {message.toolRowIds.map((id) => (
                <button className="ti-link" key={id} onClick={() => onTool(id)}>
                  {c.tool} · {id}
                </button>
              ))}
            </details>
          </div>
        ))}
      </Section>
      <Section id="ti-context-pack" title={c.contextPack}>
        <details className="ti-pack-json">
          <summary>{String(d.context.pack?.id ?? c.noContext)}</summary>
          {d.context.pack && (
            <JsonView label={c.contextPack} value={d.context.pack} />
          )}
        </details>
      </Section>
      <details className="ti-compaction-timeline">
        <summary>
          {c.compaction} · {c.events}
        </summary>
        <Timeline detail={d} compaction />
      </details>
    </>
  );
}
