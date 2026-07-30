import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban, ShieldAlert, Trash2 } from "lucide-react";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { PERMANENT_DELETE_COOKIE } from "@/lib/permanent-delete-cookie";
import {
  getPermanentDeletePreview,
  getValidPermanentDeleteGrant,
} from "@/services/permanent-delete";
import { PermanentDeleteIdentity } from "@/components/archive/permanent-delete-identity";
import { PermanentDeleteForm } from "@/components/archive/permanent-delete-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const countLabels: Record<string, string> = {
  workoutSessions: "workouts",
  sessionExercises: "exercise occurrences",
  completedSets: "sets",
  sessionNotes: "notes",
  painLogs: "pain records",
  fatigueLogs: "fatigue records",
  healthActivities: "activities",
  recommendations: "recommendations",
  userDecisions: "recommendation decisions",
  adaptationEvents: "program adaptations",
  coachingInsights: "saved coaching records",
  historyImportBatches: "import batches",
  importEvents: "source import files",
  externalExerciseMappings: "reviewed mappings",
  customExercises: "custom exercises",
  exerciseAliases: "exercise aliases",
  exerciseSources: "exercise sources",
  exerciseRequirements: "exercise requirements",
  recordVersions: "edit-history versions",
};

export default async function PermanentDeletePage({
  params,
  searchParams,
}: {
  params: Promise<{ operationId: string }>;
  searchParams: Promise<{ reauth?: string }>;
}) {
  const { operationId } = await params;
  const { reauth } = await searchParams;
  const user = await getCurrentUser();
  const db = await getDb();
  const preview = await getPermanentDeletePreview(db, user.id, operationId);
  if (!preview) notFound();
  const token = (await cookies()).get(PERMANENT_DELETE_COOKIE)?.value ?? null;
  const grant = await getValidPermanentDeleteGrant(
    db,
    user.id,
    operationId,
    token
  );
  const deleteCounts = Object.entries(preview.deleteCounts).filter(
    ([, count]) => count > 0
  );

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <Button
        render={<Link href="/archive" />}
        nativeButton={false}
        variant="ghost"
        size="sm"
        className="self-start"
      >
        <ArrowLeft className="size-4" /> Back to Archive
      </Button>
      <header>
        <div className="flex items-center gap-2">
          <Trash2 className="size-6 text-destructive" />
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Delete permanently
          </h1>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{preview.summary}</p>
      </header>

      {reauth === "failed" ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Identity verification did not match this deletion request. Nothing was
          deleted; start the identity check again.
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Exact deletion preview</CardTitle>
            <Badge variant="destructive">Irreversible in Archive</Badge>
          </div>
          <CardDescription>
            These are the current rows in this Archive action and their linked
            evidence. The database recalculates this scope again before deleting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="grid gap-2 sm:grid-cols-2">
            {deleteCounts.map(([key, count]) => (
              <li key={key} className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <span className="font-medium">{count}</span>{" "}
                <span className="text-muted-foreground">{countLabels[key] ?? key}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Preserved after deletion: {preview.preservedCounts.archiveMembership ?? 0}{" "}
            Archive membership records, {preview.preservedCounts.auditRecords ?? 0}{" "}
            related audit records, and all existing verified snapshots. The new
            pre-delete safety snapshot is also preserved outside the primary database.
          </p>
        </CardContent>
      </Card>

      {preview.blockers.length > 0 ? (
        <Card className="border-amber-300">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Ban className="size-5" /> Deletion is blocked
            </CardTitle>
            <CardDescription>
              Resolve these linked Archive scopes first. Nothing can be deleted while
              the dependency closure is ambiguous.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-2 pl-5 text-sm">
              {preview.blockers.map((blocker) => (
                <li key={blocker.key}>
                  {blocker.message} ({blocker.count})
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {grant ? "Final irreversible confirmation" : "Verify identity"}
            </CardTitle>
            <CardDescription>
              {grant
                ? "The single-use identity grant is active for this preview only and expires within minutes."
                : "A normal session cannot authorize permanent deletion."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {grant ? (
              <PermanentDeleteForm
                operationId={operationId}
                summary={preview.summary}
              />
            ) : (
              <PermanentDeleteIdentity
                operationId={operationId}
                devMode={process.env.NODE_ENV === "development"}
                ownerEmail={user.email}
              />
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        Existing provider backups and encrypted snapshots can retain older copies
        according to their recovery retention. This action permanently removes the
        reviewed rows from the current application database and Archive.
      </div>
    </main>
  );
}
