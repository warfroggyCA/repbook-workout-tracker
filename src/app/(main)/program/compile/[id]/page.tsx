import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, Play, X } from "lucide-react";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { isSessionCompilerEnabled } from "@/lib/session-compiler-feature";
import { getOwnedSessionCompilerProposal } from "@/services/session-compiler";
import { CompilerAcceptForm } from "@/components/session/compiler-accept-form";
import { CompilerExecutionDetails } from "@/components/session/compiler-execution-details";
import { CompilerResultAlert } from "@/components/session/compiler-result-alert";
import { discardCompilerProposal } from "@/app/actions/session-compiler";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Review session proposal" };

export default async function ReviewCompilerProposalPage(props: PageProps<"/program/compile/[id]">) {
  if (!isSessionCompilerEnabled()) notFound();
  const [{ id }, query] = await Promise.all([props.params, props.searchParams]);
  const user = await getCurrentUser();
  const proposal = await getOwnedSessionCompilerProposal(await getDb(), user.id, id);
  if (!proposal) notFound();
  const input = proposal.inputSnapshot;
  const output = proposal.outputSnapshot;
  const structuredGroups = input.day.supersets.flatMap((group) =>
    "structureStatus" in group
      ? [{
          key: group.key,
          name: group.name,
          structureStatus: group.structureStatus,
          plannedRounds: group.plannedRounds,
          restBetweenMembersSec: group.restBetweenMembersSec,
          restBetweenRoundsSec: group.restBetweenRoundsSec,
        }]
      : [],
  );
  const groupByKey = new Map(structuredGroups.map((group) => [group.key, group]));
  const acceptanceKey = crypto.randomUUID();
  return (
    <main className="p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-4xl space-y-4">
        <Button variant="ghost" render={<Link href={`/program/compile?day=${input.day.lineageId}`} />} nativeButton={false}><ArrowLeft /> Compiler inputs</Button>
        <header>
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Review before start</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{input.day.name} proposal</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Program v{input.programVersionNo} · {input.requestedMinutes} minutes available · {input.energy} energy recorded · deterministic algorithm {input.algorithmVersion}</p>
        </header>
        {query.status === "stale" && <CompilerResultAlert>The Program or current equipment evidence changed after this review. No workout was started. Build a fresh proposal.</CompilerResultAlert>}
        {query.status === "not_ready" && <CompilerResultAlert>This proposal is no longer available to accept. No workout was started.</CompilerResultAlert>}
        {output.status === "unable" ? (
          <section className="rounded-2xl border border-amber-500/50 bg-card p-5">
            <AlertTriangle className="size-5 text-amber-700" />
            <h2 className="mt-2 font-semibold">Unable to compile safely</h2>
            <p className="mt-2 text-sm leading-6">{output.reason}</p>
            <p className="mt-3 text-sm text-muted-foreground">{output.evidenceStatement}</p>
            {(proposal.status === "unable" || proposal.status === "stale") && (
              <form action={discardCompilerProposal.bind(null, proposal.id)} className="mt-4">
                <Button type="submit" variant="outline"><X /> Discard proposal</Button>
              </form>
            )}
          </section>
        ) : (
          <>
            <section className="rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="compiled-plan-heading">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h2 id="compiled-plan-heading" className="font-semibold">Proposed session</h2><p className="mt-1 text-sm text-muted-foreground">{output.duration!.minMinutes}–{output.duration!.maxMinutes} minutes · {output.duration!.basis.replaceAll("_", " ")} · {output.duration!.evidenceCount} comparable record{output.duration!.evidenceCount === 1 ? "" : "s"}</p></div>
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">Ready for review</span>
              </div>
              <CompilerExecutionDetails input={input} output={output} />
              <ol className="mt-4 space-y-3">
                {output.exercises.map((exercise, index) => {
                  const group = exercise.supersetKey ? groupByKey.get(exercise.supersetKey) : null;
                  return <li key={exercise.slotLineageId} className="rounded-xl border p-3"><div className="flex gap-3"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{index + 1}</span><div><p className="font-medium">{exercise.exerciseName}</p><p className="mt-1 text-sm">{exercise.sets} sets · {exercise.repMin}–{exercise.repMax} reps{group ? ` · ${group.name} member ${(exercise.groupMemberOrderIdx ?? 0) + 1}` : ` · ${exercise.restSec}s rest`}{exercise.targetLoad != null ? ` · ${exercise.targetLoad} ${exercise.targetLoadUnit}` : ""}</p><p className="mt-1 text-xs text-muted-foreground">{exercise.disposition === "full" ? "Full published dose" : `Reduced from ${exercise.sourceSets} sets; reviewed minimum retained`}</p></div></div></li>;
                })}
              </ol>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">{output.duration!.explanation}</p>
            </section>
            <section className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border bg-card p-4"><h2 className="font-semibold">Every choice</h2><ul className="mt-3 space-y-3 text-sm">{output.changes.map((change, index) => <li key={`${change.kind}:${change.slotLineageId}:${index}`} className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /><span><span className="font-medium">{change.kind.replaceAll("_", " ")}:</span> {change.reason}</span></li>)}</ul></div>
              <div className="rounded-2xl border bg-card p-4"><h2 className="font-semibold">Intent result</h2><ul className="mt-3 space-y-3 text-sm">{output.intentResults.map((result) => <li key={result.key}><span className="font-medium">{result.label} · {result.status}:</span> {result.reason}</li>)}</ul></div>
            </section>
            <section className="rounded-2xl border bg-card p-4"><h2 className="font-semibold">Warnings and evidence</h2>{output.warnings.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No reviewable training warnings are attached to this day.</p> : <ul className="mt-3 space-y-2 text-sm">{output.warnings.map((warning, index) => <li key={`${warning.code}:${index}`}><span className="font-medium">{warning.code.replaceAll("_", " ")}:</span> {warning.reason} <span className="text-muted-foreground">({warning.evidenceCount} records)</span></li>)}</ul>}<p className="mt-3 text-xs leading-5 text-muted-foreground">{output.evidenceStatement}</p></section>
            {proposal.status === "ready" ? <section className="rounded-2xl border border-primary/40 bg-card p-4 sm:p-5"><h2 className="font-semibold">Accept this occurrence</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Acceptance copies this exact reviewed proposal into a normal workout snapshot. It does not edit or publish the Program.</p><div className="mt-4"><CompilerAcceptForm proposalId={proposal.id} acceptanceKey={acceptanceKey} fallbackTimezone={user.profile.timezone}><Play /> Accept and start workout</CompilerAcceptForm></div><form action={discardCompilerProposal.bind(null, proposal.id)} className="mt-3"><Button type="submit" variant="ghost" className="w-full"><X /> Discard proposal</Button></form></section> : <section className="rounded-2xl border bg-muted/30 p-4 text-sm"><p>This proposal is {proposal.status}. It cannot create another workout.</p>{proposal.status === "stale" && <form action={discardCompilerProposal.bind(null, proposal.id)} className="mt-3"><Button type="submit" variant="outline"><X /> Discard proposal</Button></form>}</section>}
          </>
        )}
      </div>
    </main>
  );
}
