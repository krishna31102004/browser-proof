import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseDataset, type DemoDataset } from "./data.js";
import { parseBenchmark } from "./benchmark.js";
import { copyFor, REPO_URL } from "./presentation.js";
import { routeKey, useRoute, type Route } from "./router.js";
import { EvidencePage, Landing, type BenchmarkState } from "./pages-a.js";
import { BenchmarkPage, CasePage, ComparePage, NotFound } from "./pages-b.js";
import { PageState, SiteFooter, SiteHeader } from "./ui.js";
import "./style.css";

const SITE_TITLE = "BrowserProof · Verify What Browser Agents Actually Did";

function titleFor(route: Route, dataset: DemoDataset | null): string {
  switch (route.page) {
    case "home": return SITE_TITLE;
    case "evidence": return "Evidence · BrowserProof";
    case "compare": return "Agent comparison · BrowserProof";
    case "benchmark": return "Benchmark results · BrowserProof";
    case "case": { const item = dataset?.cases.find((c) => c.id === route.caseId); return item ? `${copyFor(item).title} · BrowserProof` : "Not found · BrowserProof"; }
    default: return "Not found · BrowserProof";
  }
}

function App() {
  const route = useRoute();
  const [dataset, setDataset] = useState<DemoDataset | null>(null);
  const [loadError, setLoadError] = useState("");
  const [bench, setBench] = useState<BenchmarkState>({ status: "loading" });
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  useEffect(() => {
    let active = true;
    const base = import.meta.env.BASE_URL;
    fetch(`${base}demo/index.json`)
      .then((r) => { if (!r.ok) throw new Error(`Evidence dataset returned HTTP ${r.status}`); return r.json() as Promise<unknown>; })
      .then((v) => { if (active) setDataset(parseDataset(v)); })
      .catch((e: unknown) => { if (active) setLoadError(e instanceof Error ? e.message : "Evidence could not be read"); });
    fetch(`${base}demo/benchmark.json`)
      .then((r) => { if (!r.ok) throw new Error(`Benchmark results returned HTTP ${r.status}`); return r.json() as Promise<unknown>; })
      .then((v) => { if (active) setBench({ status: "ok", data: parseBenchmark(v) }); })
      .catch((e: unknown) => { if (active) setBench({ status: "error", message: e instanceof Error ? e.message : "Benchmark results could not be read" }); });
    return () => { active = false; };
  }, []);

  const key = routeKey(route);
  useEffect(() => { document.title = titleFor(route, dataset); }, [key, dataset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
    main.current?.focus({ preventScroll: true });
  }, [key]);

  const needsDataset = route.page === "home" || route.page === "evidence" || route.page === "case" || route.page === "compare";
  let body: React.ReactNode;
  if (route.page === "benchmark") body = <BenchmarkPage bench={bench} />;
  else if (route.page === "not-found") body = <NotFound kind="route" value={route.path} />;
  else if (loadError && needsDataset) body = <PageState title="The evidence could not be loaded" role="alert"><p>{loadError}. This site only shows a validated, checked-in dataset and never substitutes placeholder runs.</p><a className="text-link" href={REPO_URL} target="_blank" rel="noreferrer">Review the source repository</a></PageState>;
  else if (!dataset) body = <PageState title="Loading recorded evidence" role="status"><p className="muted">One moment.</p></PageState>;
  else if (route.page === "home") body = <Landing dataset={dataset} bench={bench} />;
  else if (route.page === "evidence") body = <EvidencePage dataset={dataset} />;
  else if (route.page === "compare") body = <ComparePage dataset={dataset} />;
  else body = <CasePage dataset={dataset} caseId={route.page === "case" ? route.caseId : ""} event={route.page === "case" ? route.event : null} />;

  return <>
    <a className="skip-link" href="#main-content" onClick={(e) => { e.preventDefault(); main.current?.focus(); main.current?.scrollIntoView(); }}>Skip to content</a>
    <SiteHeader route={route} />
    <main id="main-content" ref={main} tabIndex={-1}>{body}</main>
    <SiteFooter />
  </>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
