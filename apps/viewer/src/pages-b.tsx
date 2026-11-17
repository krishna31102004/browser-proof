import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DemoDataset, ViewerCase } from "./data.js";
import { benchmarkFigures, type BenchmarkCase, type BenchmarkExport } from "./benchmark.js";
import { Icon } from "./icons.js";
import { Timeline } from "./Timeline.js";
import { REPO_URL, agentLabel, appNames, browserSaw, capitalise, contractLabel, copyFor, evidenceFileNames, faultLabel, formatDay, ledgerObserved, reproduceFor, screenshotCaption, signatureReason, workflowNames } from "./presentation.js";
import { BenchmarkError, type BenchmarkState } from "./pages-a.js";
import { Breadcrumb, Button, CommandBlock, Disclosure, IdChip, PageState, SectionHead, StatusPill } from "./ui.js";

// ---------- Record order (AdminBench) ----------
function RecordOrder({ item }: { item: ViewerCase }) {
  const obs = item.timeline.find((e) => e.type === "agent.observation");
  const fault = item.timeline.find((e) => e.type === "fault.triggered");
  const click = item.timeline.find((e) => e.type === "browser.click_attempt");
  const asArray = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const before = asArray(obs?.payload.observedRowOrder);
  const after = fault ? asArray(fault.payload.mutatedOrder) : before;
  if (!before.length) return <p className="muted">No record order snapshot was recorded for this run.</p>;
  const requested = typeof obs?.payload.requestedRecordId === "string" ? obs.payload.requestedRecordId : "beacon";
  const clicked = typeof click?.payload.selectedTarget === "string" ? click.payload.selectedTarget : undefined;
  const changed = item.effects[0]?.entityId;
  const row = (ids: string[], later: boolean) => <ol className="order-row">{ids.map((id) => {
    const isChanged = later && id === changed;
    const wrong = isChanged && id !== requested;
    return <li key={id} className={isChanged ? "is-changed" : ""}><span className="order-name" title={capitalise(id)}>{capitalise(id)}</span>
      <span className="order-tags">{id === requested && <span className="tag tag-req"><Icon name="check" />Requested</span>}{later && id === clicked && <span className="tag tag-click">Clicked</span>}{isChanged && <span className={`tag tag-changed${wrong ? " wrong" : ""}`}>{wrong ? <Icon name="x-circle" /> : <Icon name="ledger" />}{wrong ? "Changed in ledger (not requested)" : "Changed in ledger"}</span>}</span></li>;
  })}</ol>;
  return <div className="record-order">
    <p className="label">Order the agent observed</p>{row(before, false)}
    <p className={`order-marker${fault ? " has-fault" : ""}`}>{fault ? <><Icon name="alert-triangle" />Rows reordered here</> : "No reorder in this run"}</p>
    <p className="label">Order at the moment of the click</p>{row(after, true)}
  </div>;
}

// ---------- Screenshots + lightbox ----------
function Gallery({ item }: { item: ViewerCase }) {
  const [active, setActive] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const shots = item.screenshots;
  useEffect(() => {
    if (active === null) return;
    close.current?.focus();
    document.body.style.overflow = "hidden";
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setActive(null); return; }
      if (event.key === "ArrowRight" && shots.length > 1) setActive((i) => (i === null ? i : (i + 1) % shots.length));
      if (event.key === "ArrowLeft" && shots.length > 1) setActive((i) => (i === null ? i : (i - 1 + shots.length) % shots.length));
      if (event.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (!focusable.length) return;
      const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = "";
      root?.removeAttribute("inert");
      trigger.current?.focus();
    };
  }, [active === null, shots.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = copyFor(item).title;
  return <section className="case-section" aria-labelledby="shots-title">
    <SectionHead id="shots-title" title="Screenshots from this run" intro={shots.length ? "Captured by the runner during the recorded run. Select one to enlarge." : undefined} />
    {shots.length === 0 ? <p className="muted">No screenshots were captured for this run. The events and ledger result above are complete.</p> : <ul className="shot-grid">{shots.map((s, i) => <li key={s.src}><button type="button" className="shot" onClick={(e) => { trigger.current = e.currentTarget; setActive(i); }} aria-label={`Open screenshot: ${title}: ${screenshotCaption(s.src)}`}><img src={s.src} alt={`${title}: ${screenshotCaption(s.src)}`} loading="lazy" /><span>{screenshotCaption(s.src)}</span></button></li>)}</ul>}
    {active !== null && shots[active] && createPortal(<div className="lightbox" ref={dialog} role="dialog" aria-modal="true" aria-label="Screenshot detail" onClick={(e) => { if (e.target === e.currentTarget) setActive(null); }}>
      <button ref={close} type="button" className="icon-button lightbox-close" onClick={() => setActive(null)} aria-label="Close screenshot"><Icon name="x" size={24} /></button>
      {shots.length > 1 && <><button type="button" className="icon-button lightbox-prev" aria-label="Previous screenshot" onClick={() => setActive((active - 1 + shots.length) % shots.length)}><Icon name="chevron-left" size={24} /></button><button type="button" className="icon-button lightbox-next" aria-label="Next screenshot" onClick={() => setActive((active + 1) % shots.length)}><Icon name="chevron-right" size={24} /></button></>}
      <figure><img src={shots[active]!.src} alt={`${title}: ${screenshotCaption(shots[active]!.src)}`} /><figcaption>{screenshotCaption(shots[active]!.src)}{shots.length > 1 ? ` (${active + 1} of ${shots.length})` : ""}</figcaption></figure>
    </div>, document.body)}
  </section>;
}

export function CasePage({ dataset, caseId, event }: { dataset: DemoDataset; caseId: string; event: number | null }) {
  const index = dataset.cases.findIndex((c) => c.id === caseId);
  const item = dataset.cases[index];
  if (!item) return <NotFound kind="case" value={caseId} />;
  const c = copyFor(item);
  const isAdmin = item.scenarioId.includes("adminbench");
  const repro = reproduceFor(item);
  const run0 = item.timeline[0]?.timestamp;
  const prev = dataset.cases[index - 1]; const next = dataset.cases[index + 1];
  const reason = signatureReason(item.contract.signature, item.contract.observedCount);
  return <div className="container page case-page">
    <Breadcrumb items={[{ label: "Evidence", href: "#/evidence" }, { label: c.title }]} />
    <header className="page-head">
      <StatusPill state={item.contract.passed ? "pass" : "fail"} />
      <h1>{c.title}</h1>
      <p className="lede">{c.scenario}</p>
      <p className="meta-line">{c.app} · {faultLabel(item.faultType)} · {agentLabel(item.agent)} · Recorded {run0 ? formatDay(run0) : "date not recorded"} UTC</p>
    </header>
    <dl className="verdict">
      <div><dt>Intended</dt><dd>{c.intended}</dd></div>
      <div><dt>Browser and agent saw</dt><dd>{browserSaw(item)}</dd></div>
      <div><dt className="accent-label">Ledger observed</dt><dd>{ledgerObserved(item)}</dd></div>
      <div><dt>Contract</dt><dd><span className="v-name">{contractLabel(item.contract.name)}</span><span className={`v-result ${item.contract.passed ? "pass-text" : "fail-text"}`}><Icon name={item.contract.passed ? "check" : "x-circle"} size={20} />{item.contract.passed ? "Passed" : "Violated"}</span>{reason && <span className="v-reason">{reason}</span>}
        {item.contract.signature && <Disclosure summary="Show signature"><code className="mono wrap">{item.contract.signature}</code></Disclosure>}</dd></div>
    </dl>
    {isAdmin && <section className="case-section" aria-label="Record order"><RecordOrder item={item} /></section>}
    <section className="case-section" aria-labelledby="timeline-title">
      <SectionHead id="timeline-title" title="What the browser saw, what the ledger recorded" intro="Events appear in recorded sequence. The left lane is what the browser, agent and test runner recorded. The right lane is the independent observer and the contract. Select an event for its timestamp, payload and linked IDs." />
      <Timeline key={item.id} item={item} initialEvent={event} />
    </section>
    <Gallery item={item} />
    <section className="case-section" aria-labelledby="files-title">
      <SectionHead id="files-title" title="Raw evidence files" intro="The exported, sanitized source files for this run. They open as JSON in a new tab." />
      <ul className="row-list file-list">{evidenceFileNames.map(([key, name]) => <li key={key}><a href={item.evidenceFiles[key]} target="_blank" rel="noreferrer" aria-label={`${name}: open ${key === "events" ? "event log" : "JSON"} (opens in a new tab)`}><span className="fl-name">{name}</span><span className="fl-path mono">{item.evidenceFiles[key]}</span><span className="fl-act">Open JSON<Icon name="arrow-up-right" /></span></a></li>)}</ul>
      <Disclosure summary="Show run identifiers"><dl className="id-list"><div><dt>Source run</dt><dd className="mono wrap">{item.sourceRunId}</dd></div><div><dt>Scenario</dt><dd className="mono wrap">{item.scenarioId}</dd></div><div><dt>Fault type</dt><dd className="mono wrap">{item.faultType ?? "none"}</dd></div><div><dt>Agent policy</dt><dd className="mono wrap">{item.agent}</dd></div>{item.scheduleId && <div><dt>Schedule</dt><dd className="mono wrap">{item.scheduleId}</dd></div>}{item.effects.map((e, i) => <div key={e.effectId}><dt>Effect {i + 1}</dt><dd className="id-line"><code>{e.effectId}</code><IdChip value={e.effectId} label="effect ID" /></dd></div>)}</dl></Disclosure>
    </section>
    <section className="case-section" aria-labelledby="repro-title">
      <SectionHead id="repro-title" title="Reproduce locally" intro={repro.explanation} />
      <p className="small">This site only shows recorded evidence. Reproduction runs on your machine and produces a new run with new IDs.</p>
      <CommandBlock commands={[repro.command]} />
      <a className="text-link" href={REPO_URL} target="_blank" rel="noreferrer">Setup and prerequisites on GitHub<Icon name="arrow-up-right" /><span className="sr-only"> (opens in a new tab)</span></a>
    </section>
    <nav className="prev-next" aria-label="Case navigation">
      {prev ? <a href={`#/case/${encodeURIComponent(prev.id)}`}><span className="caption-muted">Previous case</span><strong>{copyFor(prev).title}</strong></a> : <a href="#/evidence"><span className="caption-muted">All cases</span><strong>Back to the evidence</strong></a>}
      {next ? <a className="pn-next" href={`#/case/${encodeURIComponent(next.id)}`}><span className="caption-muted">Next case</span><strong>{copyFor(next).title}</strong></a> : <a className="pn-next" href="#/evidence"><span className="caption-muted">All cases</span><strong>Back to the evidence</strong></a>}
    </nav>
  </div>;
}

// ---------- Comparison ----------
function CompareColumn({ item, title, sub }: { item: ViewerCase; title: string; sub: string }) {
  const changed = item.effects[0]?.entityId ?? "";
  return <article className="compare-col panel">
    <StatusPill state={item.contract.passed ? "pass" : "fail"} />
    <h2 className="serif-h3">{title}</h2><p className="small">{sub}</p>
    <RecordOrder item={item} />
    <dl className="facts">
      <div><dt>Browser reported</dt><dd>{browserSaw(item)}</dd></div>
      <div><dt>Ledger recorded</dt><dd>{ledgerObserved(item).split(".")[0]}</dd></div>
      <div><dt>Final record states</dt><dd className="final-states">{item.finalState.map((r) => <span key={r.entityId} className={r.entityId === changed ? "is-changed" : ""}>{capitalise(r.entityId)} {r.status}</span>)}</dd></div>
      <div><dt>Contract</dt><dd>{contractLabel(item.contract.name)}: <span className={item.contract.passed ? "pass-text" : "fail-text"}>{item.contract.passed ? "passed" : `violated (${signatureReason(item.contract.signature, item.contract.observedCount)})`}</span></dd></div>
    </dl>
    <Disclosure summary="Show run identifiers"><dl className="id-list"><div><dt>Run ID</dt><dd className="mono wrap">{item.sourceRunId}</dd></div>{item.effects[0] && <div><dt>Effect ID</dt><dd className="mono wrap">{item.effects[0].effectId}</dd></div>}<div><dt>Signature</dt><dd className="mono wrap">{item.contract.signature ?? "none"}</dd></div><div><dt>Fault type</dt><dd className="mono wrap">{item.faultType ?? "none"}</dd></div><div><dt>Agent policy</dt><dd className="mono wrap">{item.agent}</dd></div></dl></Disclosure>
    <a className="text-link" href={`#/case/${encodeURIComponent(item.id)}`}>Open this case<Icon name="arrow-right" /></a>
  </article>;
}

export function ComparePage({ dataset }: { dataset: DemoDataset }) {
  const vulnerable = dataset.cases.find((c) => c.id === "adminbench-vulnerable");
  const hardened = dataset.cases.find((c) => c.id === "adminbench-hardened");
  if (!vulnerable || !hardened) return <PageState title="Comparison unavailable"><p>The evidence set does not contain both sides of this comparison.</p><Button href="#/evidence" variant="secondary">Browse the evidence</Button></PageState>;
  const same = Boolean(vulnerable.scheduleId && vulnerable.scheduleId === hardened.scheduleId);
  return <div className="container page">
    <Breadcrumb items={[{ label: "Evidence", href: "#/evidence" }, { label: "Agent comparison" }]} />
    <header className="page-head"><h1><span>Same fault.</span> <em>Different record changed.</em></h1>
      <p className="lede">Both agents were asked to deactivate Beacon. Both runs used the same saved fault: the record list was reordered after the agent observed it and before it clicked. One agent selects by row position. The other selects by record ID.</p></header>
    <div className="shared-fault">
      <span className="label">Shared fault</span><span className="sf-fault"><Icon name="alert-triangle" />Rows reordered after observation</span>
      <span className={`sf-status ${same ? "pass-text" : "fail-text"}`}><Icon name={same ? "check" : "x-circle"} />{same ? "Same saved schedule in both runs" : "Schedules do not match"}</span>
      <Disclosure summary="Show schedule ID" className="sf-disc"><code className="mono wrap">{vulnerable.scheduleId ?? "none"}</code></Disclosure>
    </div>
    <div className="compare-grid"><CompareColumn item={vulnerable} title="Selects by row position" sub="The remembered position pointed at a different record after the reorder." /><CompareColumn item={hardened} title="Selects by record ID" sub="The agent resolved Beacon by its stable ID after the reorder." /></div>
    <section className="case-section prose" aria-labelledby="cmp-concl"><h2 id="cmp-concl">Both pages said "Record updated successfully"</h2><p className="lede">The browser's message was identical in both runs. Only the independently queried ledger shows which record changed, and only the contract says whether that was the requested one.</p></section>
    <section className="case-section" aria-labelledby="cmp-repro"><SectionHead id="cmp-repro" title="Reproduce locally" />
      <p className="label spaced">Position-based agent (expected to exit 1 with a confirmed wrong-record effect)</p><CommandBlock commands={[reproduceFor(vulnerable).command]} />
      <p className="label spaced">ID-based agent (expected to exit 0)</p><CommandBlock commands={[reproduceFor(hardened).command]} /></section>
  </div>;
}

// ---------- Benchmark ----------
function Mark({ ok, children }: { ok: boolean; children: string }) { return <span className={`bm-mark ${ok ? "ok" : "bad"}`}><span className="bm-glyph"><Icon name={ok ? "check" : "x"} /></span>{children}</span>; }

function MatrixRow({ variant, cases }: { variant: BenchmarkExport["variants"][number]; cases: BenchmarkCase[] }) {
  const clean = cases.find((c) => c.mode === "clean");
  const faults = cases.filter((c) => c.mode === "faulted");
  const [open, setOpen] = useState(false);
  const cell = (c: BenchmarkCase | undefined) => {
    if (!c) return <span className="muted">Not recorded</span>;
    if (c.mode === "clean") { const ok = c.classification === "clean_pass"; return <><Mark ok={ok}>{ok ? "Passed" : "Not a clean pass"}</Mark><span className="caption-muted">{c.effectCount} effect{c.effectCount === 1 ? "" : "s"}</span></>; }
    const detected = c.classification === "detected"; const repro = c.reproduction?.matched === true;
    return <><span className="bm-fault">{faultLabel(c.fault)}</span><span className="bm-marks"><Mark ok={detected}>{detected ? "Detected" : "Missed"}</Mark><Mark ok={repro}>{repro ? "Reproduced" : "Not reproduced"}</Mark></span></>;
  };
  return <>
    <tr className="bm-row">
      <th scope="row"><span className="bm-name">{workflowNames[variant.id] ?? variant.id}</span><span className="caption-muted">{contractLabel(variant.contract)}</span></th>
      <td data-label="No fault">{cell(clean)}</td><td data-label="Injected fault A">{cell(faults[0])}</td><td data-label="Injected fault B">{cell(faults[1])}</td>
      <td className="bm-act"><button type="button" className="text-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide identifiers" : "Show identifiers"}</button></td>
    </tr>
    {open && <tr className="bm-detail"><td colSpan={5}><dl className="id-list">{cases.map((c) => <div key={c.caseId}><dt>{c.mode === "clean" ? "No fault" : faultLabel(c.fault)}</dt><dd className="mono wrap">case {c.caseId} · run {c.runId}{c.signature ? ` · ${c.signature}` : ""} · {c.effectCount} effect(s){c.reproduction ? ` · reproduction run ${c.reproduction.runId}` : ""}</dd></div>)}</dl></td></tr>}
  </>;
}

export function BenchmarkPage({ bench }: { bench: BenchmarkState }) {
  const head = <header className="page-head"><h1>36 cases, run once, published as recorded</h1><p className="lede">Twelve workflows across three controlled apps. Each workflow runs once with no fault and twice with a different injected fault. Every number on this page is read from the committed results file.</p></header>;
  const scope = <div className="scope-note panel"><h2 className="title">Read this first</h2><p>These results come from a deterministic reference agent with no language model, running against test apps that were deliberately made non-idempotent. They validate that the harness detects the violations it was constructed to produce. They are not an estimate of how often real AI agents fail, and not a claim of universal detection accuracy.</p></div>;
  if (bench.status !== "ok") return <div className="container page">{head}{scope}{bench.status === "loading" ? <p className="muted" role="status">Loading recorded results</p> : <BenchmarkError message={bench.message} />}</div>;
  const data = bench.data; const f = benchmarkFigures(data); const m = data.metrics;
  const apps = ["supportdesk", "adminbench", "shopbench"];
  const cells: Array<[string, string]> = [[`${f.cleanPassed} / ${f.cleanPlanned}`, "clean runs passed"], [`${f.detected} / ${f.seededPlanned}`, "constructed violations detected"], [`${f.reproduced} / ${f.reproductionPlanned}`, "reproduced in a fresh run"], [String(f.falsePositives), "false positives"]];
  const commit = data.gitCommit;
  return <div className="container page benchmark-page">
    {head}{scope}
    <dl className="figures figures-xl">{cells.map(([n, l]) => <div key={l}><dd className="figure-num">{n}</dd><dt>{l}</dt></div>)}</dl>
    <p className="small muted">{m.validCompletedCases} of {m.plannedCases} cases valid. {m.infrastructureFailures + m.observerFailures + m.injectionFailures} infrastructure, observer or injection failures. {m.missed} missed.</p>
    <section className="case-section" aria-labelledby="matrix-title">
      <SectionHead id="matrix-title" title="Every case, by workflow and condition" />
      <div className="matrix panel"><table><caption className="sr-only">Benchmark results by workflow and condition</caption>
        <thead><tr><th scope="col">Workflow</th><th scope="col">No fault</th><th scope="col">Injected fault A</th><th scope="col">Injected fault B</th><th scope="col"><span className="sr-only">Identifiers</span></th></tr></thead>
        {apps.map((app) => <tbody key={app}><tr className="bm-group"><th colSpan={5} scope="colgroup">{appNames[app]}</th></tr>{data.variants.filter((v) => v.application === app).map((v) => <MatrixRow key={v.id} variant={v} cases={data.cases.filter((c) => c.variantId === v.id)} />)}</tbody>)}
      </table></div>
      <p className="caption-muted prose">Passed: the run met its contract with no fault injected. Detected: the ledger showed a violation and the run flagged it with the pre-registered signature. Reproduced: re-running the saved schedule in a new browser context gave the same signature with new effect IDs.</p>
    </section>
    <section className="case-section prose" aria-labelledby="method-title"><h2 id="method-title">How detection is counted</h2>
      <ol className="prose-list">
        <li><strong>Expected label.</strong> For each case, a function re-derives from the saved ledger effects alone whether a safety violation occurred: a duplicate commit or a commit to the wrong target. It does not read the runner's verdict.</li>
        <li><strong>Flag.</strong> The run's own contract evaluation must report a contract violation with the signature that was registered in the frozen case manifest before the run.</li>
        <li><strong>Detected.</strong> The fault triggered once at the expected phase, the observer completed, the saved artifacts passed their audit, the ledger showed a violation, and the run flagged it with the expected signature. A real violation reported under a different signature counts as missed.</li>
        <li><strong>False positive.</strong> A no-fault case that is anything other than a clean pass.</li>
        <li><strong>Reproduced.</strong> The saved schedule is executed again with a new run ID, a new browser context and a reset app. It must trigger again, pass the artifact audit, give the same signature and produce effect IDs that do not overlap the original. Trace playback is never counted as reproduction.</li>
        <li><strong>One attempt per case.</strong> No reruns are selected. Invalid, untriggered or inconclusive cases would be listed by ID and kept in the denominator. There were none.</li>
      </ol></section>
    <section className="case-section prose" aria-labelledby="limits-title"><h2 id="limits-title">Limitations</h2>
      <ul className="prose-list">
        <li>The agent is a deterministic script, not an AI model. It retries once after any visible failure, so every post-commit fault produces a duplicate by construction.</li>
        <li>The test apps were deliberately changed to be non-idempotent, so a repeated request commits a second effect. Systems that use idempotency keys would behave differently.</li>
        <li>The result measures whether the harness detects violations it was built to produce. It says nothing about how often real agents fail or about failure modes nobody constructed.</li>
        <li>The expected label and the flag both come from the same saved ledger snapshot, through separate code paths. There is no human-labelled reference and no second observer, so an observer bug would affect both.</li>
        <li>The benchmark exercises five of the ten fault types. The other five, including request abort, lead only to recovered runs or runs with no effect, which are not safety violations. They are covered by regression tests instead.</li>
        <li>One machine, local Chromium, one published pass on a clean tree at the recorded commit. A four-case wiring check and one earlier full pass on uncommitted code preceded it and are not the published result.</li>
      </ul></section>
    <section className="case-section prose" aria-labelledby="llm-title"><h2 id="llm-title">A separate 9-trial run with a language-model agent</h2><p className="lede">Outside this benchmark, 9 trials with an OpenAI GPT-6 Luna agent were recorded and their artifacts validated: 3 with no fault and one refund each, 3 with a lost response and two refunds each, and 3 fresh reproductions with matching outcomes. In the faulted trials the agent adapter began reconsidering the task before the browser observed the lost response. These trials therefore do not show that the lost response caused the retry decision.</p></section>
    <section className="case-section" aria-labelledby="prov-title"><h2 id="prov-title" className="h2">Provenance</h2>
      <dl className="dl-rows">
        <div><dt>Report ID</dt><dd className="mono wrap">{data.reportId}</dd></div>
        <div><dt>Generated (UTC)</dt><dd className="mono">{data.generatedAt}</dd></div>
        <div><dt>Source commit</dt><dd className="id-line"><a className="mono" href={`${REPO_URL}/commit/${commit}`} target="_blank" rel="noreferrer" title={commit}>{commit.slice(0, 12)}<span className="sr-only"> (opens in a new tab)</span></a><IdChip value={commit} label="commit hash" /></dd></div>
        <div><dt>Working tree</dt><dd>{data.workingTreeDirty ? "Uncommitted changes present" : "Clean"}</dd></div>
        <div><dt>Agent</dt><dd>{agentLabel(data.agent)}</dd></div>
        <div><dt>Results file</dt><dd><a className="mono" href={`${REPO_URL}/blob/${commit}/benchmarks/results.v1.json`} target="_blank" rel="noreferrer">benchmarks/results.v1.json<span className="sr-only"> (opens in a new tab)</span></a></dd></div>
        <div><dt>Frozen case manifest</dt><dd><a className="mono" href={`${REPO_URL}/blob/${commit}/benchmarks/cases.v1.json`} target="_blank" rel="noreferrer">benchmarks/cases.v1.json<span className="sr-only"> (opens in a new tab)</span></a></dd></div>
      </dl></section>
    <section className="case-section" aria-labelledby="run-title"><SectionHead id="run-title" title="Run it yourself" intro="The full benchmark takes about six minutes and runs one Chromium at a time. Run directories are written locally and are not published." />
      <CommandBlock label="Benchmark commands" commands={["pnpm install --frozen-lockfile && pnpm exec playwright install chromium", "pnpm bp benchmark run", "pnpm bp benchmark verify --report benchmarks/results.v1.json --audit-artifacts"]} /></section>
  </div>;
}

// ---------- Not found ----------
export function NotFound({ kind, value }: { kind: "route" | "case"; value: string }) {
  return <section className="container page-state not-found">
    <svg className="mark mark-muted" viewBox="0 0 24 24" width="40" height="40" fill="none" aria-hidden="true"><path d="M8 19H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><circle cx="7" cy="7" r="1.25" fill="currentColor" /><rect className="mark-ledger" x="10" y="10" width="12" height="12" rx="3" /></svg>
    <h1>Nothing recorded at this address</h1>
    <p className="lede">{kind === "case" ? <>No recorded case has the identifier <code>{value}</code>. The evidence is unchanged.</> : <>The address <code>/{value}</code> does not match any page. The evidence is unchanged.</>}</p>
    <div className="hero-actions"><Button href="#/">Back to home</Button><Button href="#/evidence" variant="secondary">Browse the evidence</Button></div>
  </section>;
}
