import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { assessHistoricalSemanticsRepair } from "@/services/historical-semantics-repair-assessment";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_VISIBLE_PROVENANCE_NODES = 250;

const COUNT_LABELS = {
  completedSets: "Completed sets",
  workoutSessions: "Completed workouts",
  calculatedOutputs: "Calculated output surfaces",
  progressionJobs: "Progression jobs",
  recommendations: "Recommendations",
  userDecisions: "Recommendation decisions",
  acceptedOrEditedDecisions: "Accepted or edited decisions",
  adaptationEvents: "Adaptation events",
  recommendationProgramVersions: "Published Program versions",
  coachingInsights: "Persisted Coach insights",
  recordVersions: "Set record versions",
  rollbackVersions: "Rollback versions",
  exportArtifacts: "Export events",
  snapshotArtifacts: "Snapshot artifacts",
} as const;

export default async function HistoricalConsequencePage(
  props: PageProps<"/recovery/semantic-consequences">,
) {
  const searchParams = await props.searchParams;
  const requestedPage = Number(searchParams.page);
  const pageNumber =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
  const user = await getCurrentUser();
  const db = await getDb();
  const assessment = await assessHistoricalSemanticsRepair(db, user.id);
  const report = assessment.consequenceGraph;
  const pageCount = Math.max(
    1,
    Math.ceil(
      Math.max(report.nodes.length, assessment.candidates.length) /
        MAX_VISIBLE_PROVENANCE_NODES,
    ),
  );
  const currentPage = Math.min(pageNumber, pageCount);
  const visibleNodes = report.nodes.slice(
    (currentPage - 1) * MAX_VISIBLE_PROVENANCE_NODES,
    currentPage * MAX_VISIBLE_PROVENANCE_NODES,
  );
  const visibleCandidates = assessment.candidates.slice(
    (currentPage - 1) * MAX_VISIBLE_PROVENANCE_NODES,
    currentPage * MAX_VISIBLE_PROVENANCE_NODES,
  );

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <Button
        render={<Link href="/recovery" />}
        nativeButton={false}
        variant="ghost"
        size="sm"
        className="-ml-2 self-start"
      >
        <ArrowLeft className="size-4" /> Back to Recovery
      </Button>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Historical consequence graph
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Exact, read-only inventory of records and outputs connected to sets
          whose performed meaning is legacy, incomplete, or unsupported.
        </p>
      </header>

      <Card className="border-emerald-300">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5" /> No mutation authorized
          </CardTitle>
          <CardDescription>
            This analysis does not rewrite a set, repair history, reverse a
            Program, change a recommendation, or alter an export or snapshot.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          If a later reviewed repair proves that a Program consequence needs
          correction, it must be published as a new user-reviewed proposal.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exact repair eligibility</CardTitle>
          <CardDescription>
            Opaque row identity, retained meaning, revision fence, excluded
            non-proof, and deterministic assessment identity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {assessment.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No historical repair candidates were found.
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Showing {visibleCandidates.length} of{" "}
                {assessment.candidates.length} exact candidates · page{" "}
                {currentPage} of {pageCount}.
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Set / workout</th>
                      <th className="px-3 py-2 font-medium">Eligibility</th>
                      <th className="px-3 py-2 font-medium">Retained tuple</th>
                      <th className="px-3 py-2 font-medium">Excluded proof</th>
                      <th className="px-3 py-2 font-medium">Assessment ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleCandidates.map((candidate) => (
                      <tr key={candidate.setId} className="border-t align-top">
                        <td className="px-3 py-2 font-mono text-xs">
                          <p>{candidate.setId}</p>
                          <p className="mt-1 text-muted-foreground">
                            {candidate.workoutSessionId ?? "missing workout"} ·
                            revision{" "}
                            {candidate.parentHistoryRevision ?? "missing"}
                          </p>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <p>{candidate.classification.replaceAll("_", " ")}</p>
                          <p className="mt-1 text-muted-foreground">
                            {candidate.reason.replaceAll("_", " ")}
                          </p>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {[
                            candidate.currentTuple.metricType,
                            candidate.currentTuple.performedSemanticsVersion,
                            candidate.currentTuple.performedLoadType,
                            candidate.currentTuple.performedLoadSemantics,
                          ]
                            .map((value) => value ?? "null")
                            .join(" · ")}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {candidate.excludedEvidence
                            .map((value) => value.replaceAll("_", " "))
                            .join(", ")}
                        </td>
                        <td className="max-w-64 break-all px-3 py-2 font-mono text-xs">
                          {candidate.idempotencyKey}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Repair assessment</CardTitle>
          <CardDescription>
            Rule {assessment.assessmentVersion} · contract activation remains
            blocked
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Review candidates", assessment.counts.candidates],
            ["Provably repairable", assessment.counts.provablyRepairable],
            ["Ambiguous", assessment.counts.ambiguous],
            ["Unsupported", assessment.counts.unsupported],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border p-3">
              <p className="text-2xl font-semibold">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
          <p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-4">
            Current catalog metadata and ordinary record versions are not
            performed-time proof. Rows without immutable evidence stay
            unchanged and explicitly unknown.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exact affected counts</CardTitle>
          <CardDescription>
            Gate {report.gateVersion} · source snapshot schema{" "}
            {report.generatedFrom.snapshotSchemaVersion}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(COUNT_LABELS).map(([key, label]) => (
            <div key={key} className="rounded-lg border p-3">
              <p className="text-2xl font-semibold">
                {report.counts[key as keyof typeof report.counts]}
              </p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inspectable provenance</CardTitle>
          <CardDescription>
            Opaque record identities and reason codes are shown without
            exposing workout notes or Coach text.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {report.nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No legacy, incomplete, or unsupported performed-set meanings were
              found.
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Showing {visibleNodes.length} of {report.nodes.length} exact
                graph nodes · page {currentPage} of {pageCount}. Counts above
                cover the complete graph.
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Kind</th>
                      <th className="px-3 py-2 font-medium">Opaque ID</th>
                      <th className="px-3 py-2 font-medium">Certainty</th>
                      <th className="px-3 py-2 font-medium">Provenance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleNodes.map((node) => (
                        <tr key={`${node.kind}:${node.id}`} className="border-t">
                          <td className="px-3 py-2">{node.kind.replaceAll("_", " ")}</td>
                          <td className="px-3 py-2 font-mono text-xs">{node.id}</td>
                          <td className="px-3 py-2 text-xs">
                            {node.certainty.replaceAll("_", " ")}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {node.provenance.join(", ")}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {pageCount > 1 && (
                <div className="mt-3 flex gap-2">
                  {currentPage > 1 && (
                    <Button
                      render={
                        <Link
                          href={`/recovery/semantic-consequences?page=${currentPage - 1}`}
                        />
                      }
                      nativeButton={false}
                      variant="outline"
                    >
                      Previous report page
                    </Button>
                  )}
                  {currentPage < pageCount && (
                    <Button
                      render={
                        <Link
                          href={`/recovery/semantic-consequences?page=${currentPage + 1}`}
                        />
                      }
                      nativeButton={false}
                      variant="outline"
                    >
                      Next report page
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
