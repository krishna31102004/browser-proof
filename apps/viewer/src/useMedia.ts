import { useEffect, useState } from "react";

export type Breakpoint = "mobile" | "tablet" | "desktop";
function current(): Breakpoint { const w = window.innerWidth; return w >= 1024 ? "desktop" : w >= 720 ? "tablet" : "mobile"; }
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(current);
  useEffect(() => {
    const a = window.matchMedia("(min-width: 1024px)"); const b = window.matchMedia("(min-width: 720px)");
    const update = () => setBp(current());
    a.addEventListener("change", update); b.addEventListener("change", update);
    return () => { a.removeEventListener("change", update); b.removeEventListener("change", update); };
  }, []);
  return bp;
}
