import { Check, ChevronDown, CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import type { ActivityItem } from "./activity-feed";
import { copy, formatCopy } from "./i18n";

export function ActivityTimeline({ items, running, expanded = false, onTool }: {
  items: ActivityItem[];
  running: boolean;
  expanded?: boolean;
  onTool: (toolCallId: string) => void;
}) {
  if (!items.length) return running ? <div className="activity-current"><LoaderCircle size={14} className="spinning" />{copy.preparingExecution}</div> : null;
  const current = [...items].reverse().find((item) => item.state === "running") ?? items.at(-1)!;
  return <details className="activity-timeline" open={running || expanded || items.some((item) => item.toolCallId) || undefined}>
    <summary><span className="activity-current">{running ? <LoaderCircle size={14} className="spinning" /> : <Check size={14} />}{running ? current.label : formatCopy(copy.executionSteps, { count: items.length })}</span><ChevronDown size={14} className="activity-chevron" /></summary>
    <ol>{items.map((item) => <li key={item.key} className={`activity-item ${item.state}`}>
      <span className="activity-node">{item.state === "running" ? <LoaderCircle size={13} className="spinning" /> : item.state === "failed" ? <CircleAlert size={13} /> : <Check size={13} />}</span>
      {item.toolCallId ? <button className="tool-event activity-tool" title={formatCopy(copy.viewToolDetail, { name: item.label })} onClick={() => onTool(item.toolCallId!)}><Wrench size={13} /><span>{item.label}</span><small>{item.state === "running" ? copy.running : item.state === "completed" ? copy.completed : copy.failed}</small></button> : <span className="activity-label">{item.label}</span>}
    </li>)}</ol>
  </details>;
}
