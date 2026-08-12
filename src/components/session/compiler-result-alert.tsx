"use client";

import { useEffect, useRef } from "react";

export function CompilerResultAlert({ children }: { children: React.ReactNode }) {
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alertRef.current?.focus();
  }, []);

  return (
    <div
      ref={alertRef}
      role="alert"
      aria-atomic="true"
      tabIndex={-1}
      className="rounded-xl border border-amber-500/50 bg-amber-50 p-3 text-sm outline-none dark:bg-amber-950/20"
    >
      {children}
    </div>
  );
}
