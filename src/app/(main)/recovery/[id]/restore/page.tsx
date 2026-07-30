import Link from "next/link";
import { ArrowLeft, Check, ShieldAlert } from "lucide-react";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { getSnapshotRestorePreview, type SnapshotRestoreScope } from "@/services/snapshot-restore";
import { runExpensiveOperation } from "@/services/expensive-operations";
import { SnapshotRestoreForm } from "@/components/recovery/snapshot-restore-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function scopeFrom(value: string | string[] | undefined): SnapshotRestoreScope {
  return value === "full" ? "full" : "history";
}

export default async function SnapshotRestorePage(
  props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }
) {
  const [{ id }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const scope = scopeFrom(searchParams.scope);
  const user = await getCurrentUser();
  const db = await getDb();
  const controlled = await runExpensiveOperation(
    db,
    user.id,
    "snapshot",
    () => getSnapshotRestorePreview(db, user.id, id, scope)
  );
  if (!controlled.ok) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
        <Button
          render={<Link href="/recovery" />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="-ml-2 self-start"
        >
          <ArrowLeft className="size-4" /> Back to Recovery
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Another snapshot operation is still running</CardTitle>
            <CardDescription>{controlled.reason}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              render={<Link href={`/recovery/${id}/restore?scope=${scope}`} />}
              nativeButton={false}
            >
              Try preview again
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }
  const preview = controlled.value;
  const changedTables = preview.tables.filter(
    (table) => table.added + table.updated + table.removed > 0
  );
  const hasChanges = changedTables.length > 0;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <header className="space-y-3">
        <Button
          render={<Link href="/recovery" />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="-ml-2"
        >
          <ArrowLeft className="size-4" /> Back to Recovery
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Restore preview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only comparison for “{preview.snapshot.name}”. Nothing has changed yet.
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Choose what to restore</CardTitle>
          <CardDescription>
            History-only is the safer option when setup and programs should stay as they are.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            render={<Link href={`/recovery/${id}/restore?scope=history`} />}
            nativeButton={false}
            variant={scope === "history" ? "default" : "outline"}
          >
            Workout & activity history
          </Button>
          <Button
            render={<Link href={`/recovery/${id}/restore?scope=full`} />}
            nativeButton={false}
            variant={scope === "full" ? "default" : "outline"}
          >
            Full data restore
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>{scope === "full" ? "Full data restore" : "History-only restore"}</CardTitle>
              <CardDescription>
                {scope === "full"
                  ? "Replaces profile, setup, programs, custom exercises, imports, archive state, workouts, activities, and coaching records. Sign-in identity, snapshots, edit history, exports, and the audit trail are preserved."
                  : "Replaces workouts, sets, notes, pain, fatigue, activities, workout imports, recommendations, and coaching history. Current profile, equipment, constraints, programs, and custom exercises are preserved."}
              </CardDescription>
            </div>
            <Badge variant="outline">
              {preview.snapshot.createdAt.toLocaleString("en-CA", { timeZone: "America/Toronto" })}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg border p-3"><p className="text-2xl font-semibold">{preview.totals.added}</p><p className="text-xs text-muted-foreground">Added</p></div>
          <div className="rounded-lg border p-3"><p className="text-2xl font-semibold">{preview.totals.updated}</p><p className="text-xs text-muted-foreground">Replaced</p></div>
          <div className="rounded-lg border p-3"><p className="text-2xl font-semibold">{preview.totals.removed}</p><p className="text-xs text-muted-foreground">Removed from current state</p></div>
          <div className="rounded-lg border p-3"><p className="text-2xl font-semibold">{preview.totals.unchanged}</p><p className="text-xs text-muted-foreground">Already matching</p></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exact changes</CardTitle>
          <CardDescription>
            Each count is calculated from the verified snapshot and a fresh read-only view of current data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {changedTables.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="size-4" /> All records in this scope already match.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Records</th>
                    <th className="px-3 py-2 font-medium">Current</th>
                    <th className="px-3 py-2 font-medium">Snapshot</th>
                    <th className="px-3 py-2 font-medium">Add</th>
                    <th className="px-3 py-2 font-medium">Replace</th>
                    <th className="px-3 py-2 font-medium">Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {changedTables.map((table) => (
                    <tr key={table.table} className="border-t">
                      <td className="px-3 py-2 font-medium">{table.label}</td>
                      <td className="px-3 py-2">{table.current}</td>
                      <td className="px-3 py-2">{table.snapshot}</td>
                      <td className="px-3 py-2">{table.added}</td>
                      <td className="px-3 py-2">{table.updated}</td>
                      <td className="px-3 py-2">{table.removed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Historical meaning consequences</CardTitle>
          <CardDescription>
            This read-only gate found records and retained outputs whose meaning
            may depend on older performed-set semantics. It does not repair
            history or reverse a Program.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg border p-3"><p className="text-2xl font-semibold">{preview.consequences.counts.completedSets}</p><p className="text-xs text-muted-foreground">Sets with unknown meaning</p></div>
            <div className="rounded-lg border p-3"><p className="text-2xl font-semibold">{preview.consequences.counts.recommendations}</p><p className="text-xs text-muted-foreground">Advice records</p></div>
            <div className="rounded-lg border p-3"><p className="text-2xl font-semibold">{preview.consequences.counts.recommendationProgramVersions}</p><p className="text-xs text-muted-foreground">Published Program versions</p></div>
            <div className="rounded-lg border p-3"><p className="text-2xl font-semibold">{preview.consequences.counts.rollbackVersions}</p><p className="text-xs text-muted-foreground">Rollback versions</p></div>
          </div>
          <p className="text-sm text-muted-foreground">
            Raw measurements are restored. Derived target outcomes are recomputed
            from retained supported meaning or invalidated as unknown. Any
            corrective Program change must be a new proposal that you review.
          </p>
        </CardContent>
      </Card>

      <Card className="border-amber-300">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldAlert className="size-5" /> Final confirmation</CardTitle>
          <CardDescription>
            The preview is checked again inside the restore. If any affected record changed, the restore stops before replacing data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SnapshotRestoreForm
            snapshotId={preview.snapshot.id}
            snapshotName={preview.snapshot.name}
            scope={scope}
            previewFingerprint={preview.fingerprint}
            hasChanges={hasChanges}
          />
        </CardContent>
      </Card>
    </main>
  );
}
