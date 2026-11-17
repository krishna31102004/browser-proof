import { useRef } from "react";
import type { DemoDataset, ViewerCase } from "./data.js";
import { benchmarkFigures, type BenchmarkExport } from "./benchmark.js";
import { Icon } from "./icons.js";
import { REPO_URL, contractLabel, copyFor, ledgerObserved, formatDay } from "./presentation.js";
import { Showcase } from "./Showcase.js";
import { prefersReducedMotion } from "./router.js";
import { Button, Disclosure, SectionHead, StatusPill } from "./ui.js";

export type BenchmarkState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: BenchmarkExport };

export function BenchmarkError({ message }: { message?: string }) { return <p className="data-error" role="alert">Benchmark results could not be loaded. No placeholder figures are shown.{message ? <span className="sr-only"> {message}</span> : null}</p>; }

function Figures({ bench, size = "lg" }: { bench: BenchmarkState; size?: "lg" | "md" }) {
  if (bench.status === "loading") return <p className="muted" role="status">Loading recorded results</p>;
  if (bench.status === "error") return <BenchmarkError message={bench.message} />;
  const f = benchmarkFigures(bench.data);
  const cells: Array<[string, string]> = [[`${f.cleanPassed} / ${f.cleanPlanned}`, "clean runs passed"], [`${f.detected} / ${f.seededPlanned}`, "constructed violations detected"], [`${f.reproduced} / ${f.reproductionPlanned}`, "reproduced in a fresh run"], [String(f.falsePositives), "false positives"]];
  return <dl className={`figures figures-${size}`}>{cells.map(([n, l]) => <div key={l}><dd className="figure-num">{n}</dd><dt>{l}</dt></div>)}</dl>;
}

export function Landing({ dataset, bench }: { dataset: DemoDataset; bench: BenchmarkState }) {
  const refund = dataset.cases.find((c) => c.id === "supportdesk-faulted") ?? dataset.cases.find((c) => c.scenarioId.includes("supportdesk") && c.mode === "faulted") ?? null;
  const showcaseHead = useRef<HTMLHeadingElement>(null);
  const showcaseSection = useRef<HTMLElement>(null);
  const watch = () => {
    const reduced = prefersReducedMotion();
    showcaseSection.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    showcaseHead.current?.focus({ preventScroll: true });
    if (!reduced) window.setTimeout(() => window.dispatchEvent(new Event("bp-replay")), 450);
  };
  const m = bench.status === "ok" ? benchmarkFigures(bench.data) : null;
  return <>
    <section className="container hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <h1 id="hero-title"><span>One lost response.</span> <em>Two refunds committed.</em></h1>
        <p className="lede">BrowserProof tests AI browser agents under controlled browser and network faults, then checks what the backend actually committed. The verdict comes from an independently queried effects ledger, not from clicks, responses, or the agent's own report.</p>
        <div className="hero-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={watch}>Watch the recorded incident<Icon name="arrow-right" /></button>
          <Button href="#/benchmark" variant="secondary" large>See benchmark results</Button>
          <a className="text-link hero-gh" href={REPO_URL} target="_blank" rel="noreferrer"><Icon name="github" />View source on GitHub<span className="sr-only"> (opens in a new tab)</span></a>
        </div>
      </div>
      <div className="hero-metric">
        {bench.status === "ok" && m ? <>
          <p className="metric-num">{m.detected} / {m.seededPlanned}</p>
          <p className="metric-label">constructed contract violations detected, each reproduced in a fresh run</p>
          <p className="metric-sub">{m.cleanPassed} of {m.cleanPlanned} clean runs passed. {m.falsePositives} false positives.</p>
          <p className="metric-scope">Measured with a deterministic reference agent on purpose-built test apps. It shows the harness catches the violations it was built to catch, not how often real AI agents fail.</p>
          <a className="text-link" href="#/benchmark">Methodology and limitations<Icon name="arrow-right" /></a>
        </> : bench.status === "error" ? <BenchmarkError message={bench.message} /> : <p className="muted" role="status">Loading recorded results</p>}
      </div>
    </section>

    <section className="container section" aria-labelledby="showcase-title" ref={showcaseSection}>
      <div className="section-head">
        <p className="section-label">Recorded incident</p>
        <h2 id="showcase-title" ref={showcaseHead} tabIndex={-1}>A refund, replayed from the record</h2>
        <p className="lede-sm">The agent was asked to refund order A123 once. This is what the browser saw and what the ledger recorded, in recorded order. Select any step to inspect the event behind it.</p>
      </div>
      {refund ? <Showcase item={refund} /> : <p className="data-error">No faulted SupportDesk run is present in this evidence set.</p>}
      {refund && <div className="section-link"><Button href={`#/case/${encodeURIComponent(refund.id)}`} variant="secondary" icon="arrow-right">Open the full case record</Button></div>}
    </section>

    <section className="container section" aria-labelledby="why-title">
      <SectionHead id="why-title" title="A browser cannot tell you what the backend did" />
      <div className="statements">
        <div><h3>A click is not a commit.</h3><p>An agent can press the right button and the operation can still fail, or happen twice.</p></div>
        <div><h3>A response is not a commit.</h3><p>A request can commit on the server while its response is lost on the way back. The browser sees a failure. The refund has already been issued.</p></div>
        <div><h3>A claim is not a commit.</h3><p>Agents report success from what is on screen. BrowserProof sets the report aside and reads the ledger.</p></div>
      </div>
    </section>

    <section className="container section" aria-labelledby="how-title">
      <SectionHead id="how-title" title="How a run is verified" intro="Four stages, each recorded with sequence numbers and correlation IDs so any conclusion can be traced back to its events." />
      <ol className="pipeline panel">
        {([
          ["browser", "Run the agent in a real browser", "The agent drives a real Playwright page against one of three controlled apps: SupportDesk, AdminBench or ShopBench."],
          ["zap", "Inject one fault at a known boundary", "A saved schedule triggers a single fault, such as a lost response or a reordered list, at an exact point in the run. Ten fault types are covered by regression tests."],
          ["eye", "Observe the backend independently", "A separate observer queries the app's effects ledger through its own control port. It never reads the browser or the agent."],
          ["file-check", "Evaluate the contract", "Typed contracts such as \"refund at most once\" are checked against the ledger. A violation gets a stable signature, and the saved schedule can be run again in a fresh browser to reproduce it."],
        ] as const).map(([icon, title, body], i) => <li key={title} className={i === 2 ? "is-observer" : ""}><span className="mono step-no">0{i + 1}</span><Icon name={icon} size={24} /><h3>{title}</h3><p>{body}</p></li>)}
      </ol>
    </section>

    <section className="container section" aria-labelledby="bench-title">
      <SectionHead id="bench-title" title="36 cases. Every constructed violation detected." />
      <Figures bench={bench} size="md" />
      <div className="scope-grid">
        <div><h3 className="title">What this does and does not show</h3><p>The benchmark runs a deterministic reference agent, with no language model, against test apps built to be non-idempotent. It shows that the harness injects each fault where intended, observes the commit independently and classifies the outcome correctly. It does not measure how often real AI agents fail, and it is not a universal detection accuracy.</p></div>
        <div><p className="small">Separately, 9 trials with an OpenAI GPT-6 Luna agent were recorded and validated. See the benchmark page for what they do and do not show.</p><Button href="#/benchmark" variant="secondary" icon="arrow-right">Full results, methodology and limitations</Button></div>
      </div>
    </section>

    <section className="container section" aria-labelledby="teaser-title">
      <SectionHead id="teaser-title" title="Five recorded runs you can open" intro="Each case includes its events, ledger effects, screenshots and contract result." />
      <ul className="row-list">{dataset.cases.map((c) => <li key={c.id}><a className="case-link-row" href={`#/case/${encodeURIComponent(c.id)}`}><span className="clr-title">{copyFor(c).title}</span><span className="clr-app">{copyFor(c).app}</span><StatusPill state={c.contract.passed ? "pass" : "fail"} /><Icon name="arrow-right" /></a></li>)}</ul>
      <div className="teaser-links"><Button href="#/evidence" variant="secondary">Browse the evidence</Button><a className="text-link" href="#/compare">Compare two agents under the same fault</a></div>
    </section>

    <section className="container section" aria-labelledby="stack-title">
      <div className="built-with">
        <h2 id="stack-title">Built with</h2>
        <dl className="dl-rows">
          {([["Language", "TypeScript on Node.js 22, pnpm workspaces"], ["Browser automation", "Playwright, Chromium"], ["Agent adapter", "Stagehand v4 with OpenAI GPT-6 Luna, used for the 9-trial campaign"], ["Verification", "Typed contracts and a versioned fault schedule registry"], ["Continuous integration", "GitHub Actions"], ["This site", "React 19, Vite 6, static hosting on Vercel"]] as const).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </div>
    </section>
  </>;
}

export function CaseEntry({ item }: { item: ViewerCase }) {
  const c = copyFor(item);
  return <li className="case-entry">
    <div className="ce-main"><StatusPill state={item.contract.passed ? "pass" : "fail"} /><h3><a className="stretch" href={`#/case/${encodeURIComponent(item.id)}`}>{c.title}</a></h3><p>{c.scenario}</p></div>
    <dl className="ce-fields">
      <div><dt>Intended</dt><dd>{c.intended}</dd></div>
      <div><dt>Ledger observed</dt><dd>{!item.contract.passed && <Icon name="x-circle" />}{ledgerObserved(item)}</dd></div>
      <div><dt>Contract</dt><dd>{contractLabel(item.contract.name)}<br /><span className={item.contract.passed ? "pass-text" : "fail-text"}>{item.contract.passed ? "Passed" : "Violated"}</span></dd></div>
    </dl>
    <span className="ce-open">Open case<Icon name="arrow-right" /></span>
  </li>;
}

export function EvidencePage({ dataset }: { dataset: DemoDataset }) {
  const groups: Array<[string, string, ViewerCase[]]> = [
    ["SupportDesk: refund an order", "The agent is asked to refund order A123 once.", dataset.cases.filter((c) => c.scenarioId.includes("supportdesk"))],
    ["AdminBench: deactivate a record", "The agent is asked to deactivate the record named Beacon.", dataset.cases.filter((c) => c.scenarioId.includes("adminbench"))],
  ];
  return <div className="container page">
    <header className="page-head"><h1>Five recorded runs, open for inspection</h1>
      <p className="lede">Each case is a real local Playwright run against a controlled test app, exported with its events, ledger effects, screenshots and contract result. The apps and their data are synthetic. The runs are real. Nothing here runs live.</p>
      <p className="caption-muted">Exported {formatDay(dataset.exportedAt)} from {dataset.provenance.sources.length} validated run artifacts.</p></header>
    {groups.map(([heading, sub, cases]) => <section key={heading} className="case-group" aria-label={heading}><h2>{heading}</h2><p className="small">{sub}</p><ul className="case-list">{cases.map((c) => <CaseEntry key={c.id} item={c} />)}</ul></section>)}
    <div className="callout panel"><div><h2 className="title">Same fault, two agents</h2><p className="small">The two AdminBench runs with reordered rows used the same saved fault. One agent selected by row position, the other by record ID.</p></div><Button href="#/compare" variant="secondary" icon="arrow-right">Open the comparison</Button></div>
    <Disclosure summary="Provenance and artifact fingerprints" className="prov-disclosure">
      <p className="small">{dataset.provenance.note}</p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Artifact fingerprints"><table className="plain-table"><thead><tr><th scope="col">Run ID</th><th scope="col">Scenario</th><th scope="col">Schedule</th><th scope="col">SHA-256</th></tr></thead><tbody>{dataset.provenance.sources.map((s) => <tr key={s.runId}><td className="mono">{s.runId}</td><td className="mono">{s.scenarioId}</td><td className="mono">{s.scheduleId ?? "none"}</td><td className="mono">{s.artifactSha256}</td></tr>)}</tbody></table></div>
    </Disclosure>
  </div>;
}

