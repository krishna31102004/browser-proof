import { useEffect, useMemo, useRef, useState } from "react";
import { filterEvents, type EventFilter, type TimelineEvent, type ViewerCase } from "./data.js";
import { Icon } from "./icons.js";
import { attemptMap, eventLabel, eventTone, formatRelative, isRightLane, keyEvents, relativeMs, sourceLabels } from "./presentation.js";
import { Inspector } from "./Inspector.js";
import { useBreakpoint } from "./useMedia.js";

const filters: Array<[EventFilter, string]> = [["all", "All"], ["observation", "Observation"], ["action", "Agent action"], ["network", "Network"], ["fault", "Fault"], ["effect", "Backend effect"], ["contract", "Contract"]];

function ToneIcon({ tone }: { tone: ReturnType<typeof eventTone> }) {
  if (tone === "fault") return <span className="tone tone-fault"><Icon name="alert-triangle" /></span>;
  if (tone === "ledger") return <span className="tone tone-ledger"><Icon name="ledger" /></span>;
  if (tone === "pass") return <span className="tone tone-pass"><Icon name="check" /></span>;
  if (tone === "fail") return <span className="tone tone-fail"><Icon name="x-circle" /></span>;
  return <span className="tone tone-dot"><i /></span>;
}

function AttemptMarker({ n }: { n: number }) {
  return <span className="attempt"><i className={n === 1 ? "shape-circle" : n === 2 ? "shape-square" : "shape-diamond"} aria-hidden="true" />Attempt {n}</span>;
}

export function Timeline({ item, initialEvent }: { item: ViewerCase; initialEvent: number | null }) {
  const bp = useBreakpoint();
  const all = item.timeline;
  const keys = useMemo(() => keyEvents(all), [all]);
  const startAll = initialEvent !== null && !keys.some((e) => e.sequence === initialEvent);
  const [view, setView] = useState<"key" | "all">(startAll ? "all" : "key");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(initialEvent !== null && all.some((e) => e.sequence === initialEvent) ? initialEvent : null);
  const list = useRef<HTMLOListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const attempts = useMemo(() => attemptMap(all), [all]);
  const visible = useMemo(() => filterEvents(view === "key" ? keys : all, filter), [view, filter, keys, all]);
  const selected = selectedSeq === null ? null : all.find((e) => e.sequence === selectedSeq) ?? null;
  const first = all[0]!;

  const updateHash = (seq: number | null) => {
    const base = `#/case/${encodeURIComponent(item.id)}`;
    window.history.replaceState(window.history.state, "", seq === null ? base : `${base}?event=${seq}`);
  };
  const select = (event: TimelineEvent | null, opts: { focusInspector?: boolean } = {}) => {
    const next = event && event.sequence !== selectedSeq ? event : null;
    setSelectedSeq(next ? next.sequence : null);
    updateHash(next ? next.sequence : null);
    if (next && opts.focusInspector && bp === "mobile") window.setTimeout(() => headingRef.current?.focus(), 0);
  };
  useEffect(() => {
    if (initialEvent === null) return;
    window.setTimeout(() => list.current?.querySelector(`[data-event-sequence="${initialEvent}"]`)?.scrollIntoView({ block: "center", behavior: "auto" }), 50);
  }, [initialEvent]);
  useEffect(() => { if (selected && !visible.some((e) => e.sequence === selected.sequence)) { setSelectedSeq(null); updateHash(null); } /* eslint-disable-next-line */ }, [visible]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button.ev") ?? [])];
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { if (selected) { select(null); event.preventDefault(); } return; }
    if (idx < 0) return;
    const go = (n: number) => { buttons[n]?.focus(); event.preventDefault(); };
    if (event.key === "ArrowDown") go(Math.min(idx + 1, buttons.length - 1));
    else if (event.key === "ArrowUp") go(Math.max(idx - 1, 0));
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(buttons.length - 1);
  };

  const related = selected?.actionId ? new Set(all.filter((e) => e.actionId === selected.actionId).map((e) => e.sequence)) : new Set<number>();
  const inspector = selected && <Inspector ref={headingRef} item={item} event={selected} onClose={() => select(null)} onSelectRelated={(e) => { setView("all"); setSelectedSeq(e.sequence); updateHash(e.sequence); }} />;

  return <div className="timeline-panel panel" onKeyDown={onKeyDown}>
    <div className="timeline-grid">
      <div className="timeline-main">
        <div className="timeline-toolbar">
          <div className="segmented" role="group" aria-label="Event view">
            <button type="button" aria-pressed={view === "key"} onClick={() => setView("key")}>Key events ({keys.length})</button>
            <button type="button" aria-pressed={view === "all"} onClick={() => setView("all")}>All events ({all.length})</button>
          </div>
          <div className="chips" role="group" aria-label="Filter timeline events">{filters.map(([value, label]) => <button type="button" key={value} className="chip" aria-pressed={filter === value} onClick={() => setFilter(value)}><span>{label}</span></button>)}</div>
        </div>
        <div className="lane-heads" aria-hidden="true"><span /><span>Browser, agent and runner</span><span className="lane-ledger-label">Independent observer and contract</span></div>
        <ol className="tl" ref={list} aria-label="Recorded execution timeline">
          {visible.map((event) => {
            const right = isRightLane(event.source);
            const isSel = selected?.sequence === event.sequence;
            const attempt = event.actionId ? attempts.get(event.actionId) : undefined;
            const label = eventLabel(event);
            const lane = right ? "Independent observer and contract" : "Browser, agent and runner";
            const btn = <button type="button" className={`ev ${right ? "ev-right" : "ev-left"}${isSel ? " is-selected" : ""}${!isSel && related.has(event.sequence) ? " is-related" : ""}`} aria-pressed={isSel} data-testid="timeline-event"
              aria-label={`Sequence ${event.sequence}, ${sourceLabels[event.source] ?? event.source}, ${lane}: ${label}.${attempt ? ` Attempt ${attempt}.` : ""}`} onClick={() => select(event, { focusInspector: true })}>
              <span className="ev-top"><ToneIcon tone={eventTone(event)} /><span className="ev-label">{label}</span></span>
              <span className="ev-sub"><span className="ev-mobile-meta mono">{String(event.sequence).padStart(2, "0")} · {formatRelative(relativeMs(all, event, first))}</span><span>{sourceLabels[event.source] ?? event.source}</span>{attempt && <AttemptMarker n={attempt} />}</span>
            </button>;
            return <li className="tl-row" key={event.sequence} data-event-sequence={event.sequence}>
              <div className="tl-seq"><span className="mono">{String(event.sequence).padStart(2, "0")}</span><span className="mono muted">{formatRelative(relativeMs(all, event, first))}</span></div>
              <div className="tl-cell tl-left" aria-hidden={right || undefined}>{!right && btn}</div>
              <div className="tl-cell tl-right" aria-hidden={!right || undefined}>{right && btn}</div>
              {bp === "mobile" && isSel && <div className="tl-inline">{inspector}</div>}
            </li>;
          })}
          {visible.length === 0 && <li className="empty-filter">No recorded events match this filter.</li>}
        </ol>
        {bp === "tablet" && <div className="tl-below">{inspector || <p className="muted">Select an event to inspect it.</p>}</div>}
      </div>
      {bp === "desktop" && <div className="timeline-side">{inspector || <p className="muted">Select an event to inspect it.</p>}</div>}
    </div>
  </div>;
}
