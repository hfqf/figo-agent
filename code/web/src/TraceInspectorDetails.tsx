import { ContextFlow } from "./TraceInspectorFlow";
import {
  Facts,
  Section,
  Timeline,
  MessageList,
  object,
  relation,
  IconButton,
  JsonView,
  observed,
  downloadEvidence,
} from "./TraceInspectorPrimitives";
export {
  IconButton,
  JsonView,
  observed,
  downloadEvidence,
} from "./TraceInspectorPrimitives";
import ReactMarkdown from "react-markdown";
import { Download, ExternalLink, ArrowRight } from "lucide-react";
import type { TraceInspectorDetail } from "../../src/contracts/trace-inspector";
import { inspectorCopy as c } from "./i18n";
import { redact, reduction, type InspectorTab } from "./trace-inspector-state";
export const INSPECTOR_TABS: InspectorTab[] = [
  "overview",
  "context-flow",
  "llm-request",
  "llm-response",
  "tool-calls",
  "compaction",
  "raw",
];
export const tabLabel = (tab: InspectorTab) =>
  ({
    overview: c.overview,
    "context-flow": c.contextFlow,
    "llm-request": c.llmRequest,
    "llm-response": c.llmResponse,
    "tool-calls": c.toolCalls,
    compaction: c.compaction,
    raw: c.raw,
  })[tab];
export const COMPACTION_TABS = [
  "process",
  "summary",
  "messages",
  "comparison",
  "metadata",
] as const;
export type CompactionTab = (typeof COMPACTION_TABS)[number];
export const compactionLabel = (tab: CompactionTab) => c[tab];
export interface DetailProps {
  detail: TraceInspectorDetail;
  tab: InspectorTab;
  compactionTab?: string;
  requestId: string | null;
  compactionEntryId: string | null;
  onRequest(id: string): void;
  onCompaction(id: string): void;
  onSource(ref: string): void;
  onTool(id: string): void;
  onOpenFile(path: string): void;
  onOpenTurn(id: string): void;
}
export function TraceInspectorDetails(props: DetailProps) {
  const {
    detail: d,
    tab,
    requestId,
    compactionEntryId,
    onRequest,
    onCompaction,
    onSource,
    onTool,
    onOpenFile,
    onOpenTurn,
  } = props;
  const capture = requestId
    ? d.captures.find((item) => item.requestId === requestId)
    : undefined;
  const entry = compactionEntryId
    ? d.compactions.find((item) => item.id === compactionEntryId)
    : undefined;
  const body = object(capture?.requestBody);
  const usingRequestIds = entry
    ? [
        ...new Set(
          d.events
            .filter(
              (event) =>
                object(object(event.payload).projection).compactionEntryId ===
                  entry.id &&
                typeof object(event.payload).requestId === "string",
            )
            .map((event) => String(object(event.payload).requestId)),
        ),
      ]
    : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const filename = `${d.row.taskId ?? "task"}-${d.row.turnId ?? "task-scope"}-${tab}-${d.row.key.slice(0, 48)}.json`;
  const artifacts = (
    <Section title={c.artifacts}>
      {d.artifacts.map((artifact, index) => (
        <div className="ti-artifact" key={String(artifact.id ?? index)}>
          <span>{String(artifact.path ?? artifact.id ?? c.unknown)}</span>
          {typeof artifact.path === "string" && (
            <IconButton
              label={c.openFile}
              onClick={() => onOpenFile(artifact.path as string)}
            >
              <ExternalLink size={14} />
            </IconButton>
          )}
          <small>{c.scope_only}</small>
        </div>
      ))}
    </Section>
  );
  return (
    <div className="ti-detail-content">
      {d.truncated && <p className="ti-warning">{c.truncated}</p>}
      {d.limitations.length > 0 && (
        <details className="ti-limitations">
          <summary>
            {c.limitations} · {d.limitations.length}
          </summary>
          {d.limitations.map((limitation, index) => (
            <p className="ti-limitation" key={index}>
              {String(redact(limitation))}
            </p>
          ))}
        </details>
      )}
      {tab === "overview" && (
        <>
          <Facts
            items={[
              [c.kind, d.row.kind],
              [c.status, d.row.status],
              [c.source, d.row.source],
              [c.time, d.row.time],
              [c.task, d.row.taskId],
              [c.turn, d.row.turnId],
              [
                c.duration,
                d.row.durationMs === null ? null : `${d.row.durationMs} ms`,
              ],
              [c.tokens, observed(d.row.tokens)],
              [c.eventKey, d.row.key],
            ]}
          />
          <Section title={c.refs}>
            <Facts items={Object.entries(d.row.refs)} />
            {d.selection.requestAssociation === "unknown" && (
              <p className="ti-warning">{c.scopeOnly}</p>
            )}
            {d.row.turnId && (
              <button
                className="ti-link"
                onClick={() => onOpenTurn(d.row.turnId!)}
              >
                <ExternalLink size={14} />
                {c.openTurn}
              </button>
            )}
            {d.captures.map((item) => (
              <button
                key={item.id}
                className="ti-link"
                onClick={() => onRequest(item.requestId)}
              >
                <ArrowRight size={14} />
                {item.requestId} · {item.purpose} · {relation(item.relation)}
              </button>
            ))}
            {d.tools.map((tool) => (
              <button
                key={tool.id}
                data-tool-id={tool.id}
                className="ti-link"
                onClick={() => onTool(tool.id)}
              >
                {tool.name} · {tool.id}
              </button>
            ))}
          </Section>
          <Section title={c.events}>
            <Timeline detail={d} />
          </Section>
          {artifacts}
        </>
      )}
      {tab === "context-flow" && <ContextFlow {...props} />}
      {(tab === "llm-request" || tab === "llm-response") &&
        (!capture ? (
          <p className="ti-empty">
            {requestId ? c.noCapture : c.selectRequest}
          </p>
        ) : (
          <>
            <Facts
              items={[
                [c.provider, capture.provider],
                [c.model, capture.model],
                [c.requestId, capture.requestId],
                [c.purpose, capture.purpose],
                [c.method, capture.method],
                [c.url, capture.url],
                [
                  c.httpStatus,
                  `${capture.responseStatus} ${capture.responseStatusText}`,
                ],
                [c.duration, `${capture.durationMs} ms`],
                [c.relation, relation(capture.relation)],
                [c.contextPack, d.selection.contextPackId],
              ]}
            />
            {tab === "llm-request" ? (
              <>
                <JsonView
                  label={c.requestHeaders}
                  value={capture.requestHeaders}
                />
                <Section title={c.actualMessages}>
                  <MessageList key={capture.requestId} messages={messages} />
                </Section>
                <JsonView
                  label={c.toolsSchema}
                  value={body.tools ?? body.availableTools ?? null}
                />
                <JsonView
                  label={c.requestBody}
                  value={capture.requestBody}
                  filename={filename}
                />
              </>
            ) : (
              <>
                <Section title={c.usage}>
                  <Facts
                    items={[
                      [c.usageStatus, capture.usage.status],
                      [
                        c.inputTokens,
                        capture.usage.promptTokens ?? c.unavailable,
                      ],
                      [
                        c.outputTokens,
                        capture.usage.completionTokens ?? c.unavailable,
                      ],
                      [
                        c.totalTokens,
                        capture.usage.totalTokens ?? c.unavailable,
                      ],
                      [c.turn, capture.usage.usageTurnId],
                    ]}
                  />
                </Section>
                <p className="ti-limitation">{c.requestNotFinal}</p>
                <JsonView
                  label={c.responseHeaders}
                  value={capture.responseHeaders}
                />
                <JsonView
                  label={c.responseBody}
                  value={capture.responseBody}
                  filename={filename}
                />
                {artifacts}
              </>
            )}
          </>
        ))}
      {tab === "tool-calls" && (
        <>
          <div className="ti-table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    c.round,
                    c.intent,
                    c.name,
                    c.status,
                    c.error,
                    c.relation,
                  ].map((name) => (
                    <th key={name}>{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.tools.map((tool) => (
                  <tr key={tool.id}>
                    <td>{tool.round ?? c.unknown}</td>
                    <td>{tool.intentId}</td>
                    <td>
                      <a href={`#ti-tool-${encodeURIComponent(tool.id)}`}>
                        {tool.name}
                      </a>
                    </td>
                    <td>{tool.status}</td>
                    <td>{tool.errorMessage}</td>
                    <td>{relation(tool.relation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.tools.map((tool) => (
            <Section key={tool.id} title={`${tool.name} · ${tool.id}`}>
              <div id={`ti-tool-${encodeURIComponent(tool.id)}`}>
                <Facts
                  items={[
                    [c.status, tool.status],
                    [c.error, tool.errorMessage],
                    [c.time, tool.startedAt],
                    [
                      c.duration,
                      tool.completedAt &&
                        `${new Date(tool.completedAt.replace(" ", "T") + "+08:00").getTime() - new Date(tool.startedAt.replace(" ", "T") + "+08:00").getTime()} ms`,
                    ],
                  ]}
                />
                <div className="ti-two-columns">
                  <JsonView label={c.input} value={tool.input} />
                  <JsonView label={c.output} value={tool.output} />
                </div>
              </div>
            </Section>
          ))}
          <Timeline detail={d} />
        </>
      )}
      {tab === "compaction" && (
        <>
          {(props.compactionTab ?? "process") === "process" && (
            <>
              <Section title={c.trigger}>
                <Timeline detail={d} compaction />
              </Section>
              {entry && (
                <p className="ti-commit">
                  {entry.completionEventStatus === "missing"
                    ? c.missingCompletion
                    : c.saved}{" "}
                  · {entry.id}
                </p>
              )}
              <Section title={c.usageEvidence}>
                <Facts
                  items={[
                    [c.entry, d.selection.projection.compactionEntryId],
                    [c.requestId, requestId],
                    [c.status, relation(d.selection.projection.status)],
                  ]}
                />
                {(!entry || !usingRequestIds.length) && (
                  <p>{c.noUsageEvidence}</p>
                )}
                {usingRequestIds.map((id) => (
                  <button
                    className="ti-link"
                    key={id}
                    onClick={() => onRequest(id)}
                  >
                    {c.usageEvidence} · {id}
                  </button>
                ))}
              </Section>
            </>
          )}
          {!entry ? (
            <p className="ti-empty">{c.noEntry}</p>
          ) : (
            <>
              <Facts
                items={[
                  [c.entry, entry.id],
                  [c.firstKept, entry.firstKeptSourceRef],
                  [c.relation, relation(entry.relation)],
                ]}
              />
              {entry.baseEntryId && (
                <button
                  className="ti-link"
                  onClick={() => onCompaction(entry.baseEntryId!)}
                >
                  <ArrowRight size={14} />
                  {c.base} · {entry.baseEntryId}
                </button>
              )}
              <Section title={c.summaryCalls}>
                {entry.requestIds.map((id) => {
                  const call = d.captures.find((item) => item.requestId === id);
                  return (
                    <div key={id} className="ti-call">
                      <button className="ti-link" onClick={() => onRequest(id)}>
                        {id}
                      </button>
                      <span>
                        {call?.purpose ?? c.unknown} ·{" "}
                        {call?.usage.totalTokens ?? c.unavailable}
                      </span>
                      <details>
                        <summary>{c.usage}</summary>
                        <Facts
                          items={[
                            [c.usageStatus, call?.usage.status],
                            [
                              c.inputTokens,
                              call?.usage.promptTokens ?? c.unavailable,
                            ],
                            [
                              c.outputTokens,
                              call?.usage.completionTokens ?? c.unavailable,
                            ],
                            [
                              c.totalTokens,
                              call?.usage.totalTokens ?? c.unavailable,
                            ],
                          ]}
                        />
                      </details>
                    </div>
                  );
                })}
              </Section>
              {props.compactionTab === "summary" && (
                <>
                  <div className="ti-section-heading">
                    <strong>{c.summary}</strong>
                    <IconButton
                      label={c.exportMarkdown}
                      onClick={() =>
                        downloadEvidence(
                          `${c.recordedScope} · ${d.row.taskId} · ${entry.id}\n\n${c.truncated}: ${d.truncated ? c.yes : c.no}\n\n${c.redacted}\n\n${String(redact(entry.summaryMarkdown))}`,
                          `${d.row.taskId}-${entry.id}.md`,
                          true,
                        )
                      }
                    >
                      <Download size={14} />
                    </IconButton>
                  </div>
                  <Facts
                    items={[
                      [c.readFiles, object(entry.details).readFiles],
                      [c.modifiedFiles, object(entry.details).modifiedFiles],
                    ]}
                  />
                  <article className="ti-markdown">
                    <ReactMarkdown
                      skipHtml
                      components={{ img: ({ alt }) => <span>{alt}</span> }}
                    >
                      {String(redact(entry.summaryMarkdown))}
                    </ReactMarkdown>
                  </article>
                </>
              )}
              {props.compactionTab === "messages" && (
                <>
                  <Section title={c.covered}>
                    {entry.coveredSourceRefs.map((ref) => (
                      <button
                        className="ti-link"
                        key={ref}
                        onClick={() => onSource(ref)}
                      >
                        {ref}
                      </button>
                    ))}
                  </Section>
                  <button
                    className="ti-link"
                    onClick={() => onSource(entry.firstKeptSourceRef)}
                  >
                    {c.firstKept} · {entry.firstKeptSourceRef}
                  </button>
                </>
              )}
              {props.compactionTab === "comparison" && (
                <>
                  <Facts
                    items={[
                      [c.before, observed(entry.tokensBefore)],
                      [c.after, observed(entry.tokensAfter)],
                      [
                        c.reduction,
                        reduction(
                          entry.tokensBefore.value,
                          entry.tokensAfter.value,
                        ) === null
                          ? c.unknown
                          : `${(reduction(entry.tokensBefore.value, entry.tokensAfter.value)! * 100).toFixed(1)}%`,
                      ],
                    ]}
                  />
                  {[entry.tokensBefore, entry.tokensAfter].map(
                    (value, index) => (
                      <div className="ti-bar-row" key={index}>
                        <span>{index ? c.after : c.before}</span>
                        {value.value === null ? (
                          <b>{c.unknown}</b>
                        ) : (
                          <>
                            <meter
                              min={0}
                              max={Math.max(
                                entry.tokensBefore.value ?? 0,
                                entry.tokensAfter.value ?? 0,
                                1,
                              )}
                              value={value.value}
                            />
                            <b>{observed(value)}</b>
                          </>
                        )}
                      </div>
                    ),
                  )}
                </>
              )}
              {props.compactionTab === "metadata" && (
                <JsonView label={c.metadata} value={entry} />
              )}
            </>
          )}
          {d.legacyCheckpoints.length > 0 && (
            <Section title={c.legacy}>
              {d.legacyCheckpoints.map((checkpoint) => (
                <details key={checkpoint.id}>
                  <summary>{checkpoint.id}</summary>
                  <JsonView label={c.legacy} value={checkpoint} />
                </details>
              ))}
            </Section>
          )}
        </>
      )}
      {tab === "raw" && (
        <JsonView label={c.rawObject} value={d} filename={filename} />
      )}
    </div>
  );
}
