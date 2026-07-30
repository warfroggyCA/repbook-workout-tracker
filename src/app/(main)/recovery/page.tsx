import Link from "next/link";
import {
  DatabaseBackup,
  FlaskConical,
  History,
  Pin,
  Search,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
} from "lucide-react";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { isDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";
import {
  defaultSnapshotName,
  listDataSnapshots,
} from "@/services/snapshots";
import { CreateSnapshotForm } from "@/components/recovery/create-snapshot-form";
import { SnapshotMetadataForm } from "@/components/recovery/snapshot-metadata-form";
import { RecoveryCheckButton } from "@/components/recovery/recovery-check-button";
import { getRecoveryHealth } from "@/services/recovery-health";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function countLabel(counts: Record<string, number>) {
  return [
    `${counts.workout_sessions ?? 0} workouts`,
    `${counts.completed_sets ?? 0} sets`,
    `${counts.health_activities ?? 0} activities`,
    `${counts.programs ?? 0} programs`,
    `${counts.history_import_batches ?? 0} imports`,
    `${counts.total ?? 0} total records`,
  ].join(" · ");
}

function healthStatusLabel(status: string | undefined) {
  if (status === "passed") return "Healthy";
  if (status === "warning") return "Review";
  if (status === "failed") return "Attention";
  return "Not checked";
}

function healthStatusVariant(status: string | undefined) {
  if (status === "passed") return "default" as const;
  if (status === "warning") return "secondary" as const;
  if (status === "failed") return "destructive" as const;
  return "outline" as const;
}

export default async function RecoveryPage(props: PageProps<"/recovery">) {
  const searchParams = await props.searchParams;
  const search = typeof searchParams.q === "string" ? searchParams.q.trim() : "";
  const user = await getCurrentUser();
  const db = await getDb();
  const [snapshots, recoveryHealth] = await Promise.all([
    listDataSnapshots(db, user.id, search),
    getRecoveryHealth(db, user.id),
  ]);
  const storageConfigured = Boolean(
    (process.env.BLOB_READ_WRITE_TOKEN ||
      ((process.env.NODE_ENV !== "production" ||
        isDisposableAcceptanceRuntime()) &&
        process.env.SNAPSHOT_LOCAL_DIR)) &&
      (process.env.SNAPSHOT_ENCRYPTION_KEY_VERSION || process.env.SNAPSHOT_ENCRYPTION_KEY_V1)
  );
  const healthItems = [
    {
      key: "database_backup",
      title: "Database backup",
      icon: DatabaseBackup,
      run: recoveryHealth.latest.database_backup,
    },
    {
      key: "restore_drill",
      title: "Isolated restore drill",
      icon: FlaskConical,
      run: recoveryHealth.latest.restore_drill,
    },
    {
      key: "snapshot_integrity",
      title: "Encrypted snapshots",
      icon: ShieldCheck,
      run: recoveryHealth.latest.snapshot_integrity,
    },
    {
      key: "application_integrity",
      title: "Application integrity",
      icon: Stethoscope,
      run: recoveryHealth.latest.application_integrity,
    },
  ];

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Recovery</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Protect a known-good state with a private encrypted copy outside the primary database.
        </p>
      </header>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Recovery health</CardTitle>
              <CardDescription className="mt-1">
                Backup availability is tracked separately from successful restore and
                application-integrity checks.
              </CardDescription>
            </div>
            <RecoveryCheckButton />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {healthItems.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.key} className="min-w-0 rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                      <Icon className="size-4 shrink-0" />
                      {item.title}
                    </div>
                    <Badge variant={healthStatusVariant(item.run?.status)}>
                      {healthStatusLabel(item.run?.status)}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {item.run?.summary ?? "No completed check has been recorded yet."}
                  </p>
                  {item.run && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Checked {item.run.completedAt.toLocaleString("en-CA", {
                        timeZone: "America/Toronto",
                      })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {recoveryHealth.attentionCount > 0 ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <div className="flex items-center gap-2 font-medium">
                <ShieldAlert className="size-4" />
                {recoveryHealth.attentionCount} item
                {recoveryHealth.attentionCount === 1 ? "" : "s"}{" "}
                {recoveryHealth.attentionCount === 1 ? "needs" : "need"} review
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                {recoveryHealth.latestFindings.slice(0, 5).map((finding) => (
                  <li key={finding.id}>{finding.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            healthItems.every((item) => item.run?.status === "passed") && (
              <div className="flex gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                Backup, restore, snapshot, and application checks are all current and healthy.
              </div>
            )
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create a verified snapshot</CardTitle>
          <CardDescription>
            The app captures active and archived records, programs, exercise IDs, imports,
            reviewed mappings, settings, provenance, recommendations, and audit history.
            It is marked verified only after the stored encrypted object can be read back,
            decrypted, and matched by checksum and record count.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {storageConfigured ? (
            <CreateSnapshotForm defaultName={defaultSnapshotName()} />
          ) : (
            <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              Private snapshot storage or its encryption key is not configured. No
              snapshot will be represented as protected until both are available.
            </div>
          )}
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Snapshots</h2>
            <p className="text-xs text-muted-foreground">
              Names do not need to be unique. Editing details never rewrites protected data.
            </p>
          </div>
          <form className="flex gap-2" action="/recovery">
            <Input name="q" defaultValue={search} placeholder="Search names and notes" />
            <Button type="submit" size="sm" variant="outline">
              <Search className="size-3.5" /> Search
            </Button>
          </form>
        </div>

        {snapshots.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {search ? "No snapshots match this search." : "No snapshots have been created yet."}
            </CardContent>
          </Card>
        ) : (
          snapshots.map((snapshot) => (
            <Card key={snapshot.id}>
              <CardHeader className="gap-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {snapshot.pinned && <Pin className="size-4" />}
                      {snapshot.name}
                    </CardTitle>
                    <CardDescription>
                      Created {snapshot.createdAt.toLocaleString("en-CA", { timeZone: "America/Toronto" })}
                      {snapshot.verifiedAt
                        ? ` · verified ${snapshot.verifiedAt.toLocaleString("en-CA", { timeZone: "America/Toronto" })}`
                        : ""}
                    </CardDescription>
                  </div>
                  <Badge variant={snapshot.status === "verified" ? "default" : "outline"}>
                    {snapshot.status === "verified" && <ShieldCheck className="size-3" />}
                    {snapshot.status === "verified" ? "Verified" : snapshot.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {snapshot.note && <p className="text-sm">{snapshot.note}</p>}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {countLabel(snapshot.recordCounts)} · {sizeLabel(snapshot.sizeBytes)} ·
                  schema {snapshot.schemaVersion} · key {snapshot.encryptionKeyVersion}
                </p>
                {snapshot.failureReason && (
                  <p role="alert" className="text-xs text-destructive">
                    Verification failed: {snapshot.failureReason}
                  </p>
                )}
                <SnapshotMetadataForm
                  snapshotId={snapshot.id}
                  initialName={snapshot.name}
                  initialNote={snapshot.note}
                  initialPinned={snapshot.pinned}
                  canDownload={snapshot.status === "verified"}
                />
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Restore status</CardTitle>
          <CardDescription>
            Verified snapshots now have read-only full and history-only restore previews.
            Every restore requires a newly verified safety copy, rechecks the exact preview,
            and applies all database changes together or none at all.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            render={<Link href="/recovery/semantic-consequences" />}
            nativeButton={false}
            variant="outline"
          >
            Inspect historical consequence graph
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Edit history</CardTitle>
          <CardDescription>
            Activity, set, exercise-note, setup, program, and reviewed-mapping changes
            retain their earlier values. Inspect all changes here; supported workout
            records can be rolled back without destroying the values you have now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            render={<Link href="/recovery/versions" />}
            nativeButton={false}
            variant="outline"
          >
            <History className="size-4" /> View edit history
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
