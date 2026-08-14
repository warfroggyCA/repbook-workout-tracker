"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Library, RefreshCw } from "lucide-react";
import { switchProgramAction } from "@/app/actions/program-library";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProgramLibraryItem } from "@/services/program-library";

export function ProgramLibrary({
  programs,
}: {
  programs: ProgramLibraryItem[];
}) {
  const router = useRouter();
  const active = programs.find((program) => program.status === "active") ?? null;
  const requestId = useRef(crypto.randomUUID());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  function switchTo(program: ProgramLibraryItem) {
    if (!active || program.status === "active" || pending) return;
    if (!window.confirm(`Make “${program.name}” your active Program? Your workout history will not change.`)) {
      return;
    }
    setError(null);
    setSwitchingId(program.id);
    startTransition(async () => {
      const result = await switchProgramAction({
        targetProgramId: program.id,
        expectedActiveProgramId: active.id,
        requestId: requestId.current,
      });
      if (!result.ok) {
        setError(result.reason);
        setSwitchingId(null);
        return;
      }
      requestId.current = crypto.randomUUID();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-xl border border-destructive/35 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {programs.map((program) => (
          <article key={program.id} className={program.status === "active" ? "rounded-2xl border border-primary/50 bg-card p-4 shadow-[var(--shadow-soft)]" : "rounded-2xl border bg-card p-4 shadow-[var(--shadow-soft)]"}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-semibold">{program.name}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {program.routineNames.length} routine{program.routineNames.length === 1 ? "" : "s"} · version {program.versionNo}
                </p>
              </div>
              {program.status === "active" && (
                <Badge variant="outline" className="border-primary/40 text-primary">
                  <CheckCircle2 className="size-3" /> Active
                </Badge>
              )}
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {program.routineNames.join(" · ")}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {program.scheduleKind === "fixed_7_day"
                ? "Seven-day schedule"
                : program.scheduleKind === "rolling"
                  ? "Rolling schedule"
                  : program.scheduleKind === "advanced"
                    ? "Multi-phase schedule"
                  : "No schedule yet"}
            </p>
            {program.status === "active" ? (
              <Button className="mt-4 min-h-11 w-full" variant="outline" render={<Link href="/program" />} nativeButton={false}>
                <Library /> View active Program
              </Button>
            ) : (
              <Button className="mt-4 min-h-11 w-full" variant="outline" disabled={pending} onClick={() => switchTo(program)}>
                <RefreshCw className={pending && switchingId === program.id ? "animate-spin" : ""} />
                {pending && switchingId === program.id ? "Switching…" : "Make active"}
              </Button>
            )}
          </article>
        ))}
      </div>
      <Button className="min-h-11 w-full sm:w-auto" render={<Link href="/program/import?destination=new" />} nativeButton={false}>
        Add a Program from routine text
      </Button>
    </div>
  );
}
