import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { FlaskConical, WandSparkles } from "lucide-react";
import { ProgramViewer } from "@/components/program/program-viewer";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db";
import { sessionCompilerProposals } from "@/db/schema";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { isSessionCompilerEnabled } from "@/lib/session-compiler-feature";
import { getCurrentUser } from "@/lib/user";
import { getCurrentProgramPreflightStatus } from "@/services/program-documents";
import { getActiveProgramPresentation } from "@/services/program-presentation";

export default async function ProgramPage(props: PageProps<"/program">) {
  const user = await getCurrentUser();
  const db = await getDb();
  const compilerEnabled = isSessionCompilerEnabled();
  // The saved-Program repair reads every day in one ownership-checked load.
  // Compiler and Preflight reads are additional only while the flag is on.
  const [presentation, query, preflightStatus] = await Promise.all([
    getActiveProgramPresentation(db, user.id),
    props.searchParams,
    compilerEnabled
      ? getCurrentProgramPreflightStatus(db, user.id)
      : Promise.resolve(null),
  ]);
  const requestedDay = typeof query.day === "string" ? query.day : null;
  const selected =
    presentation?.days.find((day) => day.lineageId === requestedDay) ??
    presentation?.days[0] ??
    null;

  const recentProposal =
    presentation && compilerEnabled
      ? ((await db.query.sessionCompilerProposals.findFirst({
          where: and(
            eq(sessionCompilerProposals.userId, user.id),
            eq(
              sessionCompilerProposals.programVersionId,
              presentation.version.id,
            ),
            sql`${sessionCompilerProposals.status} IN ('ready', 'unable', 'stale')`,
          ),
          orderBy: desc(sessionCompilerProposals.createdAt),
        })) ?? null)
      : null;

  return (
    <main className="p-4 sm:p-6 lg:p-8">
      {presentation && selected ? (
        <div className="mx-auto max-w-5xl">
          {recentProposal && (
            <section className="mb-4 flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-[var(--shadow-soft)] sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-semibold">Resume session proposal</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {recentProposal.inputSnapshot.day.name} ·{" "}
                  {recentProposal.inputSnapshot.requestedMinutes} minutes ·{" "}
                  {recentProposal.status}
                </p>
              </div>
              <Button
                variant="outline"
                render={<Link href={`/program/compile/${recentProposal.id}`} />}
                nativeButton={false}
              >
                Review proposal
              </Button>
            </section>
          )}

          <ProgramViewer
            presentation={presentation}
            initialSelectedId={selected.lineageId}
            editorEnabled={isProgramEditorEnabled()}
          />

          <section className="mt-4 rounded-2xl border border-amber-500/50 bg-amber-50/60 p-4 dark:bg-amber-950/15">
            <h2 className="font-semibold">Rehearse without recording</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Simulation uses a separate local workspace and does not change
              Today, History, Coach, progress, or records.
            </p>
            <Button
              className="mt-3 min-h-10"
              variant="outline"
              render={<Link href="/simulation" />}
              nativeButton={false}
            >
              <FlaskConical aria-hidden="true" /> Open simulation lab
            </Button>
          </section>

          {compilerEnabled && selected.intent && (
            <div className="mt-4">
              <Button
                variant="outline"
                render={
                  <Link href={`/program/compile?day=${selected.lineageId}`} />
                }
                nativeButton={false}
              >
                <WandSparkles /> Build session proposal
              </Button>
            </div>
          )}

          {compilerEnabled && (
            <section
              className="mt-4 rounded-2xl border bg-card p-4 shadow-[var(--shadow-soft)] sm:p-5"
              aria-labelledby="program-preflight-heading"
            >
              <h2 id="program-preflight-heading" className="font-semibold">
                Program checks
              </h2>
              {preflightStatus?.availability === "legacy" ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  This older Program version predates the current checks. Open a
                  draft to review its saved planning details before activating a
                  new version.
                </p>
              ) : preflightStatus?.availability === "unavailable" ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  The checks saved when this version was activated are
                  unavailable. Current evidence stays separate and does not
                  rewrite this version.
                </p>
              ) : preflightStatus?.availability === "available" &&
                preflightStatus.publication ? (
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div className="rounded-xl border p-3">
                    <h3 className="text-sm font-medium">
                      When this version was activated
                    </h3>
                    {preflightStatus.publication.durations
                      .filter(
                        (duration) =>
                          duration.dayLineageId === selected.lineageId,
                      )
                      .map((duration) => (
                        <p key={duration.dayLineageId} className="mt-2 text-sm">
                          {duration.minMinutes}–{duration.maxMinutes} min ·{" "}
                          {duration.basis.replaceAll("_", " ")} ·{" "}
                          {duration.evidenceCount} matching workout
                          {duration.evidenceCount === 1 ? "" : "s"}
                        </p>
                      ))}
                    <p className="mt-2 text-xs text-muted-foreground">
                      Checked{" "}
                      {new Date(
                        preflightStatus.publication.checkedAt,
                      ).toLocaleString()}
                      . Evidence counts describe available records, not
                      confidence.
                    </p>
                    {preflightStatus.publication.findings.filter(
                      (finding) => finding.dayLineageId === selected.lineageId,
                    ).length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No problem or warning was found for this day.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-2 text-sm">
                        {preflightStatus.publication.findings
                          .filter(
                            (finding) =>
                              finding.dayLineageId === selected.lineageId,
                          )
                          .map((finding) => {
                            const slotName = finding.slotLineageId
                              ? (selected.slots.find(
                                  (slot) =>
                                    slot.lineageId === finding.slotLineageId,
                                )?.exercise.name ?? null)
                              : null;
                            return (
                              <li key={finding.id}>
                                <span className="font-medium">
                                  {finding.severity === "blocking"
                                    ? "Needs fixing before activation"
                                    : "Worth checking"}
                                  {slotName ? ` · ${slotName}` : ""}
                                </span>
                                <span className="block text-muted-foreground">
                                  {finding.reason}
                                </span>
                              </li>
                            );
                          })}
                      </ul>
                    )}
                  </div>
                  <div className="rounded-xl border p-3">
                    <h3 className="text-sm font-medium">
                      What has changed since activation
                    </h3>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Checked{" "}
                      {new Date(preflightStatus.current.checkedAt).toLocaleString()}
                      . This current check stays separate from the saved
                      activation record.
                    </p>
                    {preflightStatus.addedFindings.filter(
                      (finding) => finding.dayLineageId === selected.lineageId,
                    ).length === 0 &&
                    preflightStatus.resolvedFindings.filter(
                      (finding) => finding.dayLineageId === selected.lineageId,
                    ).length === 0 &&
                    !preflightStatus.durationChangedDayLineageIds.includes(
                      selected.lineageId,
                    ) ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No relevant change is currently visible for this day.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-2 text-sm">
                        {preflightStatus.durationChangedDayLineageIds.includes(
                          selected.lineageId,
                        ) && (
                          <li>
                            The estimated time range or the workout history
                            behind it changed after activation.
                          </li>
                        )}
                        {preflightStatus.addedFindings
                          .filter(
                            (finding) =>
                              finding.dayLineageId === selected.lineageId,
                          )
                          .map((finding) => {
                            const slotName = finding.slotLineageId
                              ? (selected.slots.find(
                                  (slot) =>
                                    slot.lineageId === finding.slotLineageId,
                                )?.exercise.name ?? null)
                              : null;
                            return (
                              <li key={`added:${finding.id}`}>
                                <span className="font-medium">
                                  {finding.severity === "blocking"
                                    ? "New problem"
                                    : "New warning"}
                                  {slotName ? ` · ${slotName}` : ""}:
                                </span>{" "}
                                {finding.reason}{" "}
                                <span className="text-muted-foreground">
                                  ({finding.evidenceCount} records)
                                </span>
                              </li>
                            );
                          })}
                        {preflightStatus.resolvedFindings
                          .filter(
                            (finding) =>
                              finding.dayLineageId === selected.lineageId,
                          )
                          .map((finding) => {
                            const slotName = finding.slotLineageId
                              ? (selected.slots.find(
                                  (slot) =>
                                    slot.lineageId === finding.slotLineageId,
                                )?.exercise.name ?? null)
                              : null;
                            return (
                              <li key={`resolved:${finding.id}`}>
                                <span className="font-medium">
                                  No longer found
                                  {slotName ? ` · ${slotName}` : ""}:
                                </span>{" "}
                                {finding.reason}
                              </li>
                            );
                          })}
                      </ul>
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No saved check results are available for this Program
                  version yet.
                </p>
              )}
            </section>
          )}
        </div>
      ) : (
        <div className="mx-auto max-w-5xl">
          <header className="mb-5">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Active program
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
              Program
            </h1>
          </header>
          <section className="rounded-2xl border bg-card p-6 shadow-[var(--shadow-soft)]">
            <h2 className="font-semibold">No active program yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Finish guided setup or import a routine to create your first
              Program.
            </p>
            <Button
              className="mt-4"
              variant="outline"
              render={<Link href="/program/import" />}
              nativeButton={false}
            >
              Import routine
            </Button>
          </section>
        </div>
      )}
    </main>
  );
}
