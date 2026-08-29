"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function TechnicalRecordDetails({ children }: { children: ReactNode }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const revealHashTarget = useCallback(() => {
    const details = detailsRef.current;
    if (!details || window.location.hash.length < 2) return;
    const target = document.getElementById(
      decodeURIComponent(window.location.hash.slice(1)),
    );
    if (target === details || (target != null && details.contains(target))) {
      details.open = true;
    }
  }, []);

  useEffect(() => {
    function revealClickedTarget(event: MouseEvent) {
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>('a[href^="#"]')
          : null;
      const href = anchor?.getAttribute("href");
      if (!href || href.length < 2) return;
      const target = document.getElementById(decodeURIComponent(href.slice(1)));
      const details = detailsRef.current;
      if (details && target && details.contains(target)) {
        details.open = true;
      }
    }

    revealHashTarget();
    window.addEventListener("hashchange", revealHashTarget);
    document.addEventListener("click", revealClickedTarget, true);
    return () => {
      window.removeEventListener("hashchange", revealHashTarget);
      document.removeEventListener("click", revealClickedTarget, true);
    };
  }, [revealHashTarget]);

  return (
    <details
      ref={detailsRef}
      id="technical-record"
      className="group scroll-mt-4 rounded-xl border p-4"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <span>
          Technical record
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
            Corrections, archive, source, lineage, and the complete item ledger
          </span>
        </span>
        <ChevronDown
          className="size-4 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-3 space-y-4 border-t pt-4">{children}</div>
    </details>
  );
}
