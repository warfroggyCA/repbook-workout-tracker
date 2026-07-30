import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, WandSparkles } from "lucide-react";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { isSessionCompilerEnabled } from "@/lib/session-compiler-feature";
import { getActiveProgramVersion, getTemplatesWithSlots } from "@/services/program";
import { createCompilerProposal } from "@/app/actions/session-compiler";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Build session proposal" };

export default async function CompileSessionPage(props: PageProps<"/program/compile">) {
  if (!isSessionCompilerEnabled()) notFound();
  const user = await getCurrentUser();
  const db = await getDb();
  const active = await getActiveProgramVersion(db, user.id);
  if (!active) redirect("/setup");
  const templates = await getTemplatesWithSlots(db, active.version.id);
  const query = await props.searchParams;
  const selected = templates.find(({ template }) => template.lineageId === query.day) ?? templates[0];
  if (!selected) redirect("/program");
  const eligible = [2, 3].includes(active.version.documentSchemaVersion) && selected.template.intent && selected.slots.every(({ slot }) => slot.intent);

  return (
    <main className="p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <Button variant="ghost" render={<Link href={`/program?day=${selected.template.lineageId}`} />} nativeButton={false}><ArrowLeft /> Program</Button>
        <header>
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Proposal only</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Build session proposal</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Compile a reviewable form of {selected.template.name}. Nothing here changes the saved Program, and no workout starts until you review and explicitly accept the result.</p>
        </header>
        {!eligible ? (
          <section className="rounded-2xl border border-dashed bg-card p-5">
            <h2 className="font-semibold">Reviewed intent is required</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">This Program version predates reviewed intent or has incomplete reviewed intent. The compiler will not infer it from history.</p>
            <Button className="mt-4" variant="outline" render={<Link href={`/program/edit?day=${selected.template.lineageId}`} />} nativeButton={false}>Open a Program draft</Button>
          </section>
        ) : (
          <form action={createCompilerProposal} className="space-y-5 rounded-2xl border bg-card p-4 shadow-[var(--shadow-soft)] sm:p-5">
            <input type="hidden" name="dayLineageId" value={selected.template.lineageId} />
            <input type="hidden" name="clientMutationId" value={crypto.randomUUID()} />
            <fieldset className="space-y-2">
              <legend className="font-semibold">Program day</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {templates.map(({ template }) => <Link key={template.id} href={`/program/compile?day=${template.lineageId}`} className={`min-h-11 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${template.id === selected.template.id ? "border-primary bg-primary/5 font-medium" : "hover:bg-muted"}`}>{template.name}</Link>)}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm font-medium">Time available
                <span className="relative block"><input className="min-h-11 w-full rounded-lg border bg-background px-3 pr-16 text-base" name="requestedMinutes" type="number" min={5} max={600} defaultValue={selected.template.intent!.targetDuration.maxMinutes} required /><span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">minutes</span></span>
              </label>
              <label className="space-y-2 text-sm font-medium">Energy context
                <select className="min-h-11 w-full rounded-lg border bg-background px-3 text-base" name="energy" defaultValue="usual"><option value="low">Low</option><option value="usual">Usual</option><option value="good">Good</option></select>
              </label>
            </div>
            <p className="rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">Energy is recorded but does not change dose in this deterministic algorithm because the reviewed Program does not define an energy-to-dose rule.</p>
            <fieldset className="space-y-3">
              <legend className="font-semibold">Only confirm what is true for this session</legend>
              <p className="text-sm leading-6 text-muted-foreground">Recent pain may inform a warning, but it is never assumed active today. This first compiler abstains instead of guessing an alternative when a confirmed constraint or busy station affects a slot.</p>
              {selected.slots.map(({ slot, exercise }) => (
                <div key={slot.id} className="rounded-xl border p-3">
                  <p className="text-sm font-medium">{exercise.name}</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="constraintSlot" value={slot.lineageId} /> Constrained today</label>
                    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="busySlot" value={slot.lineageId} /> Equipment busy today</label>
                  </div>
                </div>
              ))}
            </fieldset>
            <Button type="submit" size="lg" className="h-auto min-h-12 w-full whitespace-normal py-3"><WandSparkles /> Review deterministic proposal</Button>
          </form>
        )}
      </div>
    </main>
  );
}
