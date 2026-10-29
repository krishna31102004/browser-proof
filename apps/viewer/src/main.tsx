import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  backendLaneEvents,
  browserLaneEvents,
  eventCorrelations,
  filterEvents,
  parseDataset,
  type DemoDataset,
  type EventFilter,
  type TimelineEvent,
  type ViewerCase,
} from "./data.js";
import "./style.css";

type Route = { page: "overview" } | { page: "case"; caseId: string } | { page: "comparison" };
const filterLabels: Array<[EventFilter, string]> = [["all", "All evidence"], ["observation", "Observation"], ["action", "Agent action"], ["network", "Network"], ["fault", "Fault"], ["effect", "Backend effect"], ["contract", "Contract"]];

function routeFromHash(): Route {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "case" && parts[1]) return { page: "case", caseId: decodeURIComponent(parts.slice(1).join("/")) };
  if (parts[0] === "compare") return { page: "comparison" };
  return { page: "overview" };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(routeFromHash);
  useEffect(() => { const update = () => setRoute(routeFromHash()); window.addEventListener("hashchange", update); return () => window.removeEventListener("hashchange", update); }, []);
  return route;
}

function App() {
  const route = useRoute();
  const [dataset, setDataset] = useState<DemoDataset | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    fetch(`${import.meta.env.BASE_URL}demo/index.json`, { cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error(`Evidence dataset returned HTTP ${response.status}.`); return response.json() as Promise<unknown>; })
      .then((value) => { if (active) setDataset(parseDataset(value)); })
      .catch((error: unknown) => { if (active) setLoadError(error instanceof Error ? error.message : "Evidence could not be read."); });
    return () => { active = false; };
  }, []);

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#/" aria-label="BrowserProof overview"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>BrowserProof</span></a>
      <nav className="primary-nav" aria-label="Evidence views">
        <a href="#/" aria-current={route.page === "overview" ? "page" : undefined}>Overview</a>
        <a href="#/case/supportdesk-faulted">SupportDesk</a>
        <a href="#/case/adminbench-vulnerable">AdminBench</a>
        <a href="#/compare">Compare agents</a>
      </nav>
      <span className="recorded-badge"><span className="record-dot" />Recorded local executions</span>
    </header>
    <main id="main-content">
      {!dataset && !loadError && <div className="page-state" role="status">Loading checked-in evidence…</div>}
      {loadError && <section className="page-state error-state" role="alert"><h1>Evidence is unavailable</h1><p>{loadError}</p><p>The viewer needs a valid checked-in dataset at <code>/demo/index.json</code>. No placeholder runs are shown.</p></section>}
      {dataset && route.page === "overview" && <Overview dataset={dataset} />}
      {dataset && route.page === "case" && <CasePage dataset={dataset} caseId={route.caseId} />}
      {dataset && route.page === "comparison" && <ComparisonPage dataset={dataset} />}
    </main>
    <footer className="footer"><span>Read-only evidence workbench</span><span>Recorded browser and backend observations · no hosted agent execution</span><a href="https://github.com/krishna31102004/browser-proof" target="_blank" rel="noreferrer">Source repository</a></footer>
  </div>;
}

function Overview({ dataset }: { dataset: DemoDataset }) {
  const refund = pickRefundCase(dataset.cases);
  const admin = pickAdminCase(dataset.cases, "vulnerable");
  const types = [...new Set(dataset.cases.map((item) => item.faultType).filter((item): item is string => Boolean(item)))];
  return <div className="page overview-page">
    <section className="intro-block">
      <div className="intro-copy"><p className="eyebrow">A recorded browser incident</p><h1>The agent saw a failure.<br />The backend had already committed.</h1><p className="lede">BrowserProof lines up what the browser reported with what an independent ledger confirmed, then checks the action against its contract.</p></div>
      <div className="dataset-stamp"><span className="stamp-mark" aria-hidden="true">BP</span><div><strong>Curated evidence set</strong><span>{dataset.cases.length} recorded cases · {types.length} fault types</span><time dateTime={dataset.exportedAt}>Exported {formatDate(dataset.exportedAt)}</time></div></div>
    </section>
    {refund ? <section aria-labelledby="incident-title" className="feature-incident"><div className="section-head"><div><p className="eyebrow">SupportDesk · {refund.sourceRunId}</p><h2 id="incident-title">The response disappeared after the refund commit</h2></div><StatusPill passed={refund.contract.passed} status={refund.status} /></div><DualLaneTimeline item={refund} compact /><div className="incident-bottom"><div><strong>{refund.effects.length} backend-confirmed refunds</strong><span>Contract: {refund.contract.name} · {refund.contract.passed ? "passed" : "violation recorded"}</span></div><a className="text-link" href={`#/case/${encodeURIComponent(refund.id)}`}>Inspect refund evidence</a></div></section> : <EmptyEvidence text="No faulted SupportDesk execution is available in this evidence set." />}
    <section className="overview-lower"><div className="case-list"><div className="section-head"><div><p className="eyebrow">Evidence index</p><h2>Recorded investigations</h2></div><span className="count-label">{dataset.cases.length} cases</span></div>
      {dataset.cases.map((item) => <CaseRow key={item.id} item={item} />)}
    </div><aside className="overview-aside"><p className="eyebrow">What to compare</p><h2>Same fault. Different agent strategy.</h2><p>The AdminBench pair reuses one saved DOM reorder schedule. One agent trusts its old row index; the other resolves Beacon by stable ID.</p>{admin && <div className="aside-proof"><span className="mini-status breach">Vulnerable target</span><strong>{admin.effects[0]?.entityId ?? "No confirmed target"}</strong><span>Independent backend ledger</span></div>}<a className="button-link" href="#/compare">Open the A/B comparison</a><p className="provenance-note">All records are synthetic test data from genuine local Playwright executions. This static viewer does not run agents.</p></aside></section>
    <ReproduceSection item={refund} />
  </div>;
}

function CasePage({ dataset, caseId }: { dataset: DemoDataset; caseId: string }) {
  const item = dataset.cases.find((candidate) => candidate.id === caseId);
  if (!item) return <section className="page-state"><h1>Case not found</h1><p>This identifier is not present in the checked-in evidence dataset.</p><a href="#/">Return to overview</a></section>;
  const isAdmin = item.scenarioId.includes("adminbench");
  return <div className="page case-page">
    <div className="breadcrumb"><a href="#/">Overview</a><span>/</span><span>{isAdmin ? "AdminBench" : "SupportDesk"}</span></div>
    <section className="case-heading"><div><p className="eyebrow">{isAdmin ? "AdminBench" : "SupportDesk"} · {item.mode === "faulted" ? formatFaultType(item.faultType) : "clean execution"}</p><h1>{item.title}</h1><p className="lede">Run <code>{item.sourceRunId}</code> · Agent policy <code>{item.agent}</code></p></div><StatusPill passed={item.contract.passed} status={item.status} /></section>
    {isAdmin && <RecordOrder item={item} />}
    <section className="evidence-panel"><div className="section-head"><div><p className="eyebrow">Sequence from recorded events</p><h2>What the agent saw / what the backend confirmed</h2></div><span className="source-note">Observer: {item.observerStatus}</span></div><DualLaneTimeline item={item} /></section>
    <EvidenceExplorer item={item} />
    {item.screenshots.length > 0 && <ScreenshotGallery screenshots={item.screenshots} />}
    <section className="case-summary-grid"><div className="summary-box"><p className="eyebrow">Requested</p><strong>{item.requestedEntity}</strong><span>{item.contract.name}</span></div><div className="summary-box"><p className="eyebrow">Backend committed</p>{item.effects.map((effect) => <strong key={effect.effectId}>{effect.entityId} <small>{effect.kind}</small></strong>)}<span>{item.effects.length} independently observed effect{item.effects.length === 1 ? "" : "s"}</span></div><div className="summary-box"><p className="eyebrow">Contract verdict</p><strong>{item.contract.passed ? "Passed" : "Violation"}</strong><span>{item.contract.signature ?? `${item.contract.observedCount} observed effect(s)`}</span></div></section>
    <EvidenceFiles item={item} />
    <ReproduceSection item={item} />
  </div>;
}

function ComparisonPage({ dataset }: { dataset: DemoDataset }) {
  const vulnerable = pickAdminCase(dataset.cases, "vulnerable");
  const hardened = pickAdminCase(dataset.cases, "hardened");
  if (!vulnerable || !hardened) return <EmptyEvidence text="The checked-in dataset does not contain both sides of a verified AdminBench comparison." />;
  const sameSchedule = Boolean(vulnerable.scheduleId && vulnerable.scheduleId === hardened.scheduleId);
  return <div className="page comparison-page"><div className="breadcrumb"><a href="#/">Overview</a><span>/</span><span>Compare agents</span></div><section className="case-heading"><div><p className="eyebrow">AdminBench · same recorded fault schedule</p><h1>One stale index. Two outcomes.</h1><p className="lede">Both runs received the same DOM reorder. Only the selection strategy changed.</p></div><span className={sameSchedule ? "schedule-match" : "schedule-mismatch"} role="status">{sameSchedule ? "Schedule IDs match" : "Schedule mismatch"}</span></section>
    <div className="schedule-band"><span>Saved schedule</span><code>{vulnerable.scheduleId ?? "Missing schedule ID"}</code><span className="schedule-separator">→</span><code>{hardened.scheduleId ?? "Missing schedule ID"}</code></div>
    <div className="comparison-grid"><AgentComparison item={vulnerable} label="Vulnerable policy" explanation="Reuses Beacon’s observed row index after the list changes." /><AgentComparison item={hardened} label="Hardened policy" explanation="Resolves the row by Beacon’s stable record ID after the list changes." /></div>
    <div className="comparison-conclusion"><span className="conclusion-symbol" aria-hidden="true">≠</span><div><strong>Same browser fault, different committed target</strong><p>The target below comes from each independent effect ledger. The contract is evaluated against the requested record and final backend state.</p></div></div>
    <ReproduceSection item={hardened} />
  </div>;
}

function AgentComparison({ item, label, explanation }: { item: ViewerCase; label: string; explanation: string }) {
  return <article className={`agent-comparison ${item.agent === "vulnerable-index" ? "is-vulnerable" : "is-hardened"}`}><div className="comparison-title"><div><h2>{label}</h2><p>{explanation}</p></div><StatusPill passed={item.contract.passed} status={item.status} /></div><RecordOrder item={item} compact /><dl className="comparison-facts"><div><dt>Committed target</dt><dd>{item.effects.map((effect) => effect.entityId).join(", ") || "No observed effect"}</dd></div><div><dt>Contract</dt><dd>{item.contract.passed ? "Passed" : item.contract.signature ?? "Violation"}</dd></div><div><dt>Final state</dt><dd>{item.finalState.map((record) => `${record.entityId} ${record.status}`).join(" · ")}</dd></div><div><dt>Fault triggered</dt><dd>{item.faultType ?? "No fault"}</dd></div></dl><a className="text-link" href={`#/case/${encodeURIComponent(item.id)}`}>Open run evidence</a></article>;
}

function RecordOrder({ item, compact = false }: { item: ViewerCase; compact?: boolean }) {
  const observation = item.timeline.find((event) => event.type.includes("observation"));
  const fault = item.timeline.find((event) => event.type.includes("fault") && event.type.includes("trigger"));
  const beforeRaw = observation?.payload.observedRowOrder ?? observation?.payload.originalOrder;
  const afterRaw = fault?.payload.mutatedOrder ?? fault?.payload.actualOrder;
  const before = Array.isArray(beforeRaw) ? beforeRaw.map(String) : [];
  const after = Array.isArray(afterRaw) ? afterRaw.map(String) : [];
  const target = item.effects[0]?.entityId;
  if (!before.length && !after.length) return <div className={`record-order ${compact ? "compact" : ""}`}><span className="source-note">No recorded row-order snapshot in this case.</span></div>;
  return <div className={`record-order ${compact ? "compact" : ""}`}><div className="order-state"><span className="order-label">Agent observed</span><ol>{before.map((id) => <li key={id} className={id === "beacon" ? "requested-row" : ""}>{recordName(id)}{id === "beacon" && <small>requested</small>}</li>)}</ol></div><div className="order-transition" aria-hidden="true">{fault ? "DOM changed before click" : "no reorder recorded"}</div><div className="order-state"><span className="order-label">At action time</span><ol>{(after.length ? after : before).map((id) => <li key={id} className={id === target ? "committed-row" : id === "beacon" ? "requested-row" : ""}>{recordName(id)}{id === target ? <small>committed</small> : id === "beacon" ? <small>requested</small> : null}</li>)}</ol></div></div>;
}

function DualLaneTimeline({ item, compact = false }: { item: ViewerCase; compact?: boolean }) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const [selected, setSelected] = useState<TimelineEvent | null>(null);
  const events = useMemo(() => filterEvents(compact ? keyEvidenceEvents(item.timeline) : item.timeline, filter), [item.timeline, filter, compact]);
  const browserEvents = browserLaneEvents(events);
  const backendEvents = backendLaneEvents(events);
  const browserKeys = new Set(browserEvents.flatMap(eventCorrelations));
  const backendKeys = new Set(backendEvents.flatMap(eventCorrelations));
  const linkedKeys = new Set([...browserKeys].filter((key) => backendKeys.has(key)));
  const rows = events.map((event) => ({ event, lane: browserEvents.includes(event) ? "browser" : "backend" as const }));

  return <div className={`timeline-wrap ${compact ? "timeline-compact" : ""}`}>
    {!compact && <div className="filter-bar" role="group" aria-label="Filter timeline events">{filterLabels.map(([value, label]) => <button key={value} type="button" className={filter === value ? "filter-chip selected" : "filter-chip"} aria-pressed={filter === value} onClick={() => { setFilter(value); setSelected(null); }}>{label}</button>)}</div>}
    {compact && <p className="key-event-note">Key events shown: {events.length} of {item.timeline.length} recorded events. Open the case for the full sequence.</p>}
    <div className="lane-headings"><span aria-hidden="true">Seq</span><span><i className="lane-dot browser-dot" />Browser / agent</span><span><i className="lane-dot backend-dot" />Backend ground truth</span></div>
    <div className="timeline-rows" role="list" aria-label="Recorded execution timeline">
      {rows.map(({ event, lane }) => {
        const keys = eventCorrelations(event).filter((key) => linkedKeys.has(key));
        return <div className={`timeline-row ${selected?.sequence === event.sequence ? "active" : ""}`} role="listitem" key={`${event.sequence}-${event.type}`}>
          <div className="sequence-cell"><span>{event.sequence}</span><time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time></div>
          <div className={`lane-cell browser-cell ${lane === "browser" ? "has-event" : ""}`}>{lane === "browser" && <EventNode event={event} lane="browser" selected={selected?.sequence === event.sequence} onSelect={() => setSelected(event)} correlationKeys={keys} />}</div>
          <div className={`lane-cell backend-cell ${lane === "backend" ? "has-event" : ""}`}>{lane === "backend" && <EventNode event={event} lane="backend" selected={selected?.sequence === event.sequence} onSelect={() => setSelected(event)} correlationKeys={keys} />}</div>
        </div>;
      })}
      {events.length === 0 && <p className="empty-filter">No recorded events match this filter.</p>}
    </div>
    {linkedKeys.size > 0 && <p className="correlation-note"><span className="correlation-mark" /> Shared chips indicate matching recorded IDs across lanes. {linkedKeys.size} ID relationship{linkedKeys.size === 1 ? "" : "s"} shown.</p>}
    {selected && <EventInspector event={selected} onClose={() => setSelected(null)} />}
  </div>;
}

function EventNode({ event, lane, selected, onSelect, correlationKeys }: { event: TimelineEvent; lane: "browser" | "backend"; selected: boolean; onSelect: () => void; correlationKeys: string[] }) {
  return <button type="button" className={`event-node ${lane}-event ${eventTone(event.type)} ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected} aria-label={`Sequence ${event.sequence}, ${event.source}: ${event.label}`}>
    <span className="event-heading"><span className="event-source">{sourceLabel(event.source)}</span><span className="event-sequence">#{event.sequence}</span></span><strong>{event.label}</strong>
    {correlationKeys.length > 0 && <span className="event-correlations">{correlationKeys.slice(0, 2).map((key) => <code key={key}>{key}</code>)}</span>}
  </button>;
}

function EventInspector({ event, onClose }: { event: TimelineEvent; onClose: () => void }) {
  return <aside className="event-inspector" aria-label="Selected event details"><div className="inspector-head"><div><p className="eyebrow">Sequence {event.sequence} · {sourceLabel(event.source)}</p><h3>{event.label}</h3><p className="evidence-basis">Evidence basis: {sourceBasis(event.source)}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close event details">×</button></div><dl className="event-meta"><div><dt>Recorded time</dt><dd><time dateTime={event.timestamp}>{formatDateTime(event.timestamp)}</time></dd></div><div><dt>Event type</dt><dd><code>{event.type}</code></dd></div>{event.agentStepId && <div><dt>Agent step</dt><dd><code>{event.agentStepId}</code></dd></div>}{event.actionId && <div><dt>Action ID</dt><dd><code>{event.actionId}</code></dd></div>}{event.requestId && <div><dt>Request ID</dt><dd><code>{event.requestId}</code></dd></div>}{event.effectId && <div><dt>Effect ID</dt><dd><code>{event.effectId}</code></dd></div>}</dl><details><summary>Allowlisted event payload</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details></aside>;
}

function EvidenceExplorer({ item }: { item: ViewerCase }) {
  return <section className="evidence-explorer"><div className="section-head"><div><p className="eyebrow">Traceability</p><h2>Explore the recorded evidence</h2></div><span className="source-note">Source run {item.sourceRunId}</span></div><div className="evidence-links">{Object.entries(item.evidenceFiles).map(([name, path]) => <a key={name} href={path} target="_blank" rel="noreferrer"><span>{name}</span><strong>Open JSON</strong></a>)}</div><p className="provenance-note">The timeline is trace playback of recorded local events. Fresh-schedule reproduction runs the saved schedule again in a new browser context; it is a separate operation.</p></section>;
}

function ScreenshotGallery({ screenshots }: { screenshots: ViewerCase["screenshots"] }) {
  const [active, setActive] = useState<ViewerCase["screenshots"][number] | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) {
      trigger.current?.focus();
      return;
    }
    closeButton.current?.focus();
    const containTabFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const root = dialog.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }
      const current = document.activeElement;
      if (!root.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (current === first || current === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || current === root)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", containTabFocus, true);
    return () => document.removeEventListener("keydown", containTabFocus, true);
  }, [active]);
  return <section className="screenshot-section"><div className="section-head"><div><p className="eyebrow">Captured browser view</p><h2>Screenshots from this run</h2></div></div><div className="screenshot-grid">{screenshots.map((shot) => <button className="screenshot-thumb" type="button" key={shot.src} onClick={(event) => { trigger.current = event.currentTarget; setActive(shot); }} aria-label={`Open screenshot: ${shot.alt}`}><img src={shot.src} alt={shot.alt} loading="lazy" /><span>{shot.alt}</span></button>)}</div>{active && <div ref={dialog} className="lightbox" role="dialog" aria-modal="true" aria-label="Screenshot detail" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") setActive(null); }} onClick={(event) => { if (event.target === event.currentTarget) setActive(null); }}><button ref={closeButton} type="button" className="lightbox-close" onClick={() => setActive(null)} aria-label="Close screenshot">×</button><figure><img src={active.src} alt={active.alt} /><figcaption>{active.alt}</figcaption></figure></div>}</section>;
}

function EvidenceFiles({ item }: { item: ViewerCase }) {
  const files = Object.entries(item.evidenceFiles);
  return <details className="file-details"><summary>Evidence files and provenance</summary><dl>{files.map(([name, path]) => <div key={name}><dt>{name}</dt><dd><a href={path} target="_blank" rel="noreferrer">{path}</a></dd></div>)}</dl><p>Export provenance: genuine local Playwright execution. Run IDs and effect IDs link to the recorded artifact source.</p></details>;
}

function ReproduceSection({ item }: { item: ViewerCase | null }) {
  const [copied, setCopied] = useState(false);
  const isAdmin = Boolean(item?.scenarioId.includes("adminbench"));
  const policy = item?.agent === "vulnerable-index" ? "vulnerable" : "hardened";
  const command = isAdmin ? `pnpm bp regression --fixture regressions/adminbench-dom-reorder --agent ${policy}` : "pnpm bp verify";
  async function copy() { try { await navigator.clipboard.writeText(command); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } }
  const explanation = isAdmin
    ? policy === "vulnerable" ? "This fresh run applies the versioned DOM schedule. Exit 1 is expected only when the independent ledger confirms the wrong target and the safety contract fails." : "This fresh run applies the versioned DOM schedule to the hardened policy and requires a Beacon commit with a passing contract."
    : "This command generates new SupportDesk runs, checks the post-commit response-loss contract, and reproduces the saved fault schedule in three fresh browser contexts.";
  return <section className="reproduce-panel"><div><p className="eyebrow">Run it locally</p><h2>Reproduce the saved fault schedule</h2><p>{explanation} The viewer itself remains static and read-only.</p></div><div className="command-box"><code>{command}</code><button type="button" onClick={copy}>{copied ? "Copied" : "Copy command"}</button></div><a href="https://github.com/krishna31102004/browser-proof" target="_blank" rel="noreferrer">Repository setup and prerequisites</a></section>;
}

function CaseRow({ item }: { item: ViewerCase }) {
  return <a className="case-row" href={`#/case/${encodeURIComponent(item.id)}`}><span className={`case-icon ${item.contract.passed ? "pass" : "fail"}`} aria-hidden="true">{item.contract.passed ? "✓" : "!"}</span><span className="case-row-main"><strong>{item.title}</strong><span>{item.scenarioId} · {item.agent} · {item.sourceRunId}</span></span><span className="case-row-result">{item.effects.length} effect{item.effects.length === 1 ? "" : "s"}<small>{item.contract.passed ? "Contract passed" : "Contract violation"}</small></span><span aria-hidden="true">›</span></a>;
}

function StatusPill({ passed, status }: { passed: boolean; status: string }) { return <span className={`status-pill ${passed ? "status-pass" : "status-fail"}`}><i aria-hidden="true" />{passed ? "Contract passed" : status === "contract_violation" ? "Contract violation" : status}</span>; }
function EmptyEvidence({ text }: { text: string }) { return <section className="page-state"><h1>Evidence set is incomplete</h1><p>{text}</p><a href="#/">Return to overview</a></section>; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "date unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date); }
function formatDateTime(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date); }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }).format(date); }
function sourceLabel(source: string): string { return source === "observer" ? "Observer" : source === "contract" ? "Contract" : source === "backend" ? "Backend" : source === "runner" ? "Runner" : source === "browser" ? "Browser" : "Agent"; }
function sourceBasis(source: string): string { return source === "observer" ? "independently queried control-plane ledger" : source === "contract" ? "typed contract evaluation" : source === "backend" ? "controlled backend event" : source === "runner" ? "runner-instrumented boundary" : source === "browser" ? "browser-visible request or outcome" : "agent action or observation record"; }
function eventTone(type: string): string { const normalized = type.toLowerCase(); if (normalized.includes("contract")) return normalized.includes("violation") ? "tone-breach" : "tone-contract"; if (normalized.includes("fault") || normalized.includes("failed")) return "tone-fault"; if (normalized.includes("commit") || normalized.includes("effect")) return "tone-effect"; if (normalized.includes("request") || normalized.includes("network")) return "tone-network"; return "tone-observation"; }
function keyEvidenceEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const types = new Set(["agent.observation", "browser.click_attempt", "backend.commit_confirmed", "fault.triggered", "network.request_failed", "agent.retry_reason", "contract.evaluated"]);
  const seen = new Set<string>();
  return events.filter((event) => {
    if (!types.has(event.type)) return false;
    if (event.type === "agent.observation" && seen.has(event.type)) return false;
    seen.add(event.type);
    return true;
  });
}
function recordName(id: string): string { return id === "beacon" ? "Beacon" : id === "alice" ? "Alice" : id === "cirrus" ? "Cirrus" : id; }
function formatFaultType(type: string | null): string { return type === "commit_then_response_lost" ? "commit then response lost" : type === "dom_replace_after_observation" ? "DOM reorder after observation" : type ?? "unknown fault"; }
function pickRefundCase(cases: ViewerCase[]): ViewerCase | null { return cases.find((item) => item.scenarioId.includes("supportdesk") && item.mode === "faulted") ?? null; }
function pickAdminCase(cases: ViewerCase[], agent: "vulnerable" | "hardened"): ViewerCase | null { return cases.find((item) => item.scenarioId.includes("adminbench") && item.mode === "faulted" && (agent === "vulnerable" ? item.agent === "vulnerable-index" : item.agent === "hardened-stable-id")) ?? null; }

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
