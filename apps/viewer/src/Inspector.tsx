import { forwardRef } from "react";
import type { TimelineEvent, ViewerCase } from "./data.js";
import { Icon } from "./icons.js";
import { eventLabel, formatRelative, formatUtc, relativeMs, sourceBasis, sourceLabels } from "./presentation.js";
import { IdChip } from "./ui.js";

export interface InspectorProps {
  item: ViewerCase;
  event: TimelineEvent;
  related?: TimelineEvent[];
  onSelectRelated?: (event: TimelineEvent) => void;
  onClose?: () => void;
  caseLink?: string;
  origin?: TimelineEvent;
}

export const Inspector = forwardRef<HTMLHeadingElement, InspectorProps>(function Inspector({ item, event, related, onSelectRelated, onClose, caseLink, origin }, ref) {
  const rel = related ?? item.timeline.filter((e) => e.actionId && e.actionId === event.actionId && e.sequence !== event.sequence);
  return <aside className="inspector" aria-label="Selected event details" key={event.sequence}>
    <div className="inspector-head">
      <h3 ref={ref} tabIndex={-1}>{eventLabel(event)}</h3>
      {onClose && <button type="button" className="icon-button" aria-label="Close event details" onClick={onClose}><Icon name="x" size={20} /></button>}
    </div>
    <dl className="inspector-meta">
      <div><dt>Sequence</dt><dd className="mono">{String(event.sequence).padStart(2, "0")} <span className="muted">{formatRelative(relativeMs(item.timeline, event, origin))}</span></dd></div>
      <div><dt>Recorded at (UTC)</dt><dd className="mono"><time dateTime={event.timestamp}>{formatUtc(event.timestamp)}</time></dd></div>
      <div><dt>Source</dt><dd>{sourceLabels[event.source] ?? event.source}</dd></div>
      <div><dt>Evidence basis</dt><dd>{sourceBasis[event.source] ?? "Recorded event"}</dd></div>
      <div><dt>Event type</dt><dd className="mono">{event.type}</dd></div>
      {event.agentStepId && <div><dt>Agent step</dt><dd className="id-line"><code>{event.agentStepId}</code><IdChip value={event.agentStepId} label="agent step" /></dd></div>}
      {event.actionId && <div><dt>Action ID</dt><dd className="id-line"><code>{event.actionId}</code><IdChip value={event.actionId} label="action ID" /></dd></div>}
      {event.requestId && <div><dt>Request ID</dt><dd className="id-line"><code>{event.requestId}</code><IdChip value={event.requestId} label="request ID" /></dd></div>}
      {event.effectId && <div><dt>Effect ID</dt><dd className="id-line"><code>{event.effectId}</code><IdChip value={event.effectId} label="effect ID" /></dd></div>}
    </dl>
    {rel.length > 0 && <div className="related"><p className="label">Related events</p><div className="related-list">{rel.map((e) => onSelectRelated
      ? <button type="button" className="related-btn" key={e.sequence} onClick={() => onSelectRelated(e)} title={eventLabel(e)}><span className="mono">{String(e.sequence).padStart(2, "0")}</span> {eventLabel(e)}</button>
      : <span className="related-btn static" key={e.sequence}><span className="mono">{String(e.sequence).padStart(2, "0")}</span> {eventLabel(e)}</span>)}</div></div>}
    <details className="payload"><summary><Icon name="chevron-right" />Recorded payload</summary><pre tabIndex={0} aria-label="Recorded payload">{Object.keys(event.payload).length ? JSON.stringify(event.payload, null, 2) : "No payload recorded for this event."}</pre></details>
    {caseLink && <a className="text-link" href={caseLink}>Open this event in the full timeline <Icon name="arrow-right" /></a>}
  </aside>;
});
