import { useEffect, useState } from "react";

export type Route =
  | { page: "home" }
  | { page: "evidence" }
  | { page: "case"; caseId: string; event: number | null }
  | { page: "compare" }
  | { page: "benchmark" }
  | { page: "not-found"; path: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart, query = ""] = raw.split("?", 2) as [string, string?];
  if (!pathPart) return { page: "home" };
  const parts = pathPart.split("/").filter(Boolean);
  if (parts[0] === "case" && parts[1]) {
    try {
      const ev = new URLSearchParams(query).get("event");
      const n = ev !== null && /^\d+$/.test(ev) ? Number(ev) : null;
      return { page: "case", caseId: decodeURIComponent(parts.slice(1).join("/")), event: n };
    } catch { return { page: "not-found", path: pathPart }; }
  }
  if (parts.length === 1 && parts[0] === "evidence") return { page: "evidence" };
  if (parts.length === 1 && parts[0] === "compare") return { page: "compare" };
  if (parts.length === 1 && parts[0] === "benchmark") return { page: "benchmark" };
  return { page: "not-found", path: pathPart };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

export function routeKey(route: Route): string {
  return route.page === "case" ? `case:${route.caseId}` : route.page === "not-found" ? `nf:${route.path}` : route.page;
}

export const prefersReducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}
