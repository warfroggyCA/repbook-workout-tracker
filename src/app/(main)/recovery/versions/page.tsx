import Link from "next/link";
import {
  ArrowLeft,
  Activity,
  CalendarClock,
  Dumbbell,
  Repeat2,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "@/db";
import { equipmentItems, exercises } from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import {
  listRecordVersions,
  VERSIONED_ENTITY_TYPES,
  type VersionedEntityType,
} from "@/services/record-versions";
import { RestoreVersionButton } from "@/components/recovery/restore-version-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  readSetCorrectionEvidence,
  SET_CORRECTION_CATEGORY_LABELS,
} from "@/lib/set-correction";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

const FIELD_LABELS: Record<string, string> = {
  activity_type: "Activity type",
  average_heart_rate_bpm: "Average heart rate",
  average_pace_seconds_per_km: "Average pace",
  distance_km: "Distance",
  duration_seconds: "Duration",
  elevation_gain_m: "Elevation gain",
  energy_kcal: "Energy",
  intensity: "Intensity",
  note: "Set note",
  exercise_id: "Exercise",
  modification_type: "Workout state",
  original_metrics: "Original units",
  reps: "Repetitions",
  rpe: "Effort rating",
  source_metadata: "Source details",
  started_at: "Date and time",
  finished_at: "Finish time",
  local_date: "Workout date",
  performed_time_precision: "Time precision",
  exclude_duration_from_analytics: "Excluded from duration insights",
  data_quality_flags: "Timing quality",
  target_met: "Legacy target projection",
  target_load: "Planned load",
  timezone: "Timezone",
  title: "Title",
  weight: "Weight",
  affected_patterns: "Affected movements",
  attrs: "Details",
  available: "Available",
  avoid: "Avoid",
  bar_weight: "Bar weight",
  cautious: "Cautious",
  confirmed_at: "Confirmed at",
  count_per_side: "Count per side",
  denomination: "Plate weight",
  label: "Label",
  pain_stop_threshold: "Pain stop threshold",
  quantity: "Quantity",
  source_equipment: "Source equipment",
  source_name: "Source exercise",
  status: "Program status",
  type: "Equipment type",
  age_range: "Age range",
  experience: "Experience",
  goals: "Goals",
  session_length_min: "Session length",
  weekly_frequency: "Weekly frequency",
  coaching_prefs: "Coaching preferences",
  verdict: "Fit result",
  reason_code: "Physical reason",
  reason_note: "Owner note",
  equipment_item_id: "Exact equipment item",
  provenance: "Reviewed by",
  reviewed_at: "Reviewed at",
};

const HIDDEN_TECHNICAL_FIELDS = new Set([
  "fingerprint",
  "source_metadata",
  "evidence_revision",
  "semantics_version",
]);

function fieldLabel(entityType: string, field: string) {
  if (field === "note") {
    if (entityType === "constraint") return "Constraint note";
    if (entityType === "completed_set") return "Set note";
    return "Note";
  }
  if (field === "notes") {
    return entityType === "session_exercise" ? "Exercise note" : "Activity notes";
  }
  if (field === "substituted_for_exercise_id") return "Originally planned exercise";
  if (field === "substitution_reason") return "Alternative reason";
  if (field === "substituted_at") return "Alternative chosen";
  if (field === "skip_reason") return "Skip reason";
  return FIELD_LABELS[field] ?? field.replaceAll("_", " ");
}

function displayValue(
  field: string,
  value: unknown,
  exerciseNames: Map<string, string>,
  equipmentNames: Map<string, string>,
  timezone = "America/Toronto",
) {
  if (value == null || value === "") return "Not recorded";
  if (field === "exercise_id" || field === "substituted_for_exercise_id") {
    return exerciseNames.get(String(value)) ?? "Exercise no longer available";
  }
  if (field === "equipment_item_id") {
    return equipmentNames.get(String(value)) ?? "Equipment item no longer available";
  }
  if (field === "verdict") {
    return value === "compatible" ? "Compatible" : "Incompatible";
  }
  if (field === "reason_code") {
    return String(value).replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
  }
  if (field === "provenance") return "Owner review";
  if (field === "modification_type") {
    return {
      as_planned: "As planned",
      substituted: "Substituted",
      added: "Added",
      skipped: "Skipped",
    }[String(value)] ?? String(value);
  }
  if (field === "skip_reason") {
    return String(value).charAt(0).toUpperCase() + String(value).slice(1);
  }
  if (field === "substitution_reason") {
    return String(value)
      .replaceAll("_", " ")
      .replace(/^./, (character) => character.toUpperCase());
  }
  if (field === "substituted_at") {
    return new Date(String(value)).toLocaleString();
  }
  if (field === "duration_seconds" && typeof value === "number") {
    return `${Math.round(value / 60)} min`;
  }
  if (field === "distance_km" && typeof value === "number") {
    return `${value.toFixed(2)} km`;
  }
  if (field === "average_pace_seconds_per_km" && typeof value === "number") {
    const minutes = Math.floor(value / 60);
    const seconds = Math.round(value % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds} /km`;
  }
  if (
    (field === "started_at" || field === "finished_at") &&
    typeof value === "string"
  ) {
    return new Date(value).toLocaleString("en-CA", { timeZone: timezone });
  }
  if (field === "performed_time_precision") {
    return value === "date_only" ? "Date only" : "Exact time";
  }
  if (field === "confirmed_at" && typeof value === "string") {
    return new Date(value).toLocaleString("en-CA", { timeZone: "America/Toronto" });
  }
  if (field === "original_metrics" && value && typeof value === "object") {
    const metrics = value as Record<string, unknown>;
    return [
      metrics.distanceValue != null
        ? `${metrics.distanceValue} ${metrics.distanceUnit ?? ""}`.trim()
        : null,
      metrics.elevationValue != null
        ? `${metrics.elevationValue} ${metrics.elevationUnit ?? ""} elevation`.trim()
        : null,
    ].filter(Boolean).join(" · ") || "Not recorded";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function recordLabel(
  entityType: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  exerciseNames: Map<string, string>,
  equipmentNames: Map<string, string>,
) {
  if (entityType === "health_activity") {
    return String(after.title || before.title || after.activity_type || "Activity");
  }
  if (entityType === "workout_session") {
    return String(after.template_name || before.template_name || "Completed workout");
  }
  if (entityType === "session_exercise") {
    const id = String(after.exercise_id || before.exercise_id || "");
    return exerciseNames.get(id) ?? "Workout exercise";
  }
  if (entityType === "equipment_item" || entityType === "barbell_config") {
    return String(after.label || before.label || "Equipment");
  }
  if (entityType === "plate_inventory") {
    return `${after.denomination ?? before.denomination ?? "?"} plate`;
  }
  if (entityType === "constraint") {
    const bodyPart = String(after.body_part || before.body_part || "Workout");
    return `${bodyPart.charAt(0).toUpperCase()}${bodyPart.slice(1)} constraint`;
  }
  if (entityType === "program") {
    return String(after.name || before.name || "Program");
  }
  if (entityType === "external_exercise_mapping") {
    return String(after.source_name || before.source_name || "Exercise mapping");
  }
  if (entityType === "user_profile") return "Training profile";
  if (entityType === "exercise_equipment_fit_assertion") {
    const exerciseId = String(after.exercise_id || before.exercise_id || "");
    const equipmentItemId = String(
      after.equipment_item_id || before.equipment_item_id || "",
    );
    return `${exerciseNames.get(exerciseId) ?? "Exercise"} with ${equipmentNames.get(equipmentItemId) ?? "saved equipment"}`;
  }
  const setNo = after.set_no ?? before.set_no ?? "?";
  return `Set ${setNo}`;
}

function actionLabel(action: string) {
  if (action === "set.retry_update") return "Offline retry correction";
  if (action === "set.active_correction") return "Reviewed active-workout correction";
  if (action === "set.completed_correction") return "Reviewed completed-set correction";
  if (action === "workout_session.timing_correction") {
    return "Reviewed workout timing correction";
  }
  if (action.endsWith(".version_restore")) return "Earlier version restored";
  if (action === "session_exercise.note_update") return "Exercise note edited";
  if (action === "session_exercise.skip") return "Exercise skipped";
  if (action === "session_exercise.unskip") return "Exercise returned";
  if (action === "session_exercise.substitute") return "Exercise substituted";
  if (action.endsWith(".create")) return "Added";
  if (action.endsWith(".retire") || action.endsWith(".remove")) return "Removed from current setup";
  if (action === "program.deactivate") return "Replaced by a newer program";
  if (action === "mapping.update") return "Reviewed mapping changed";
  if (action === "profile.manage.update") return "Profile reviewed and updated";
  if (action === "coaching.manage.update") return "Coaching preferences updated";
  return "Edited";
}

function entityLabel(entityType: string) {
  if (entityType === "health_activity") return "Activity";
  if (entityType === "workout_session") return "Workout timing";
  if (entityType === "session_exercise") return "Workout exercise";
  if (entityType === "equipment_item") return "Equipment";
  if (entityType === "plate_inventory") return "Plate inventory";
  if (entityType === "barbell_config") return "Bar configuration";
  if (entityType === "constraint") return "Constraint";
  if (entityType === "program") return "Program";
  if (entityType === "external_exercise_mapping") return "Exercise mapping";
  if (entityType === "user_profile") return "Profile & coaching";
  if (entityType === "exercise_equipment_fit_assertion") {
    return "Movement compatibility";
  }
  return "Set";
}

const RESTORABLE_ENTITY_TYPES = new Set([
  "health_activity",
  "workout_session",
  "completed_set",
  "session_exercise",
]);

export default async function EditHistoryPage(
  props: PageProps<"/recovery/versions">
) {
  const searchParams = await props.searchParams;
  const requested = typeof searchParams.type === "string" ? searchParams.type : "";
  const type = VERSIONED_ENTITY_TYPES.includes(requested as VersionedEntityType)
    ? (requested as VersionedEntityType)
    : undefined;
  const user = await getCurrentUser();
  const db = await getDb();
  const versions = await listRecordVersions(db, user.id, type);
  const exerciseIds = Array.from(
    new Set(
      versions.flatMap((version) =>
        [
          version.beforeData.exercise_id,
          version.afterData.exercise_id,
          version.beforeData.substituted_for_exercise_id,
          version.afterData.substituted_for_exercise_id,
        ].filter((id): id is string => typeof id === "string")
      )
    )
  );
  const exerciseRows = exerciseIds.length
    ? await db.query.exercises.findMany({
        where: and(
          inArray(exercises.id, exerciseIds),
          or(isNull(exercises.userId), eq(exercises.userId, user.id)),
        ),
        columns: { id: true, name: true },
      })
    : [];
  const exerciseNames = new Map(exerciseRows.map((exercise) => [exercise.id, exercise.name]));
  const equipmentItemIds = Array.from(new Set(versions.flatMap((version) => [
    version.beforeData.equipment_item_id,
    version.afterData.equipment_item_id,
  ].filter((id): id is string => typeof id === "string"))));
  const equipmentRows = equipmentItemIds.length
    ? await db.query.equipmentItems.findMany({
        where: and(
          inArray(equipmentItems.id, equipmentItemIds),
          eq(equipmentItems.userId, user.id),
        ),
        columns: { id: true, label: true },
      })
    : [];
  const equipmentNames = new Map(equipmentRows.map((item) => [item.id, item.label]));

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <header>
        <Button render={<Link href="/recovery" />} nativeButton={false} size="sm" variant="ghost" className="mb-2">
          <ArrowLeft className="size-3.5" /> Recovery
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Edit history</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Inspect meaningful workout, setup, program, and reviewed-mapping changes. Supported workout records can safely return to earlier values.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>How rollback stays recoverable</CardTitle>
          <CardDescription>
            Every real edit retains its before-and-after values. Restoring first creates
            a verified encrypted snapshot, and the values being replaced become a new
            version rather than disappearing.
          </CardDescription>
        </CardHeader>
      </Card>

      <nav aria-label="Edit history filters" className="flex flex-wrap gap-2">
        <Button render={<Link href="/recovery/versions" />} nativeButton={false} size="sm" variant={type ? "outline" : "default"}>
          All
        </Button>
        <Button render={<Link href="/recovery/versions?type=health_activity" />} nativeButton={false} size="sm" variant={type === "health_activity" ? "default" : "outline"}>
          <Activity className="size-3.5" /> Activities
        </Button>
        <Button render={<Link href="/recovery/versions?type=workout_session" />} nativeButton={false} size="sm" variant={type === "workout_session" ? "default" : "outline"}>
          <CalendarClock className="size-3.5" /> Workout timing
        </Button>
        <Button render={<Link href="/recovery/versions?type=completed_set" />} nativeButton={false} size="sm" variant={type === "completed_set" ? "default" : "outline"}>
          <Dumbbell className="size-3.5" /> Sets
        </Button>
        <Button render={<Link href="/recovery/versions?type=session_exercise" />} nativeButton={false} size="sm" variant={type === "session_exercise" ? "default" : "outline"}>
          <Repeat2 className="size-3.5" /> Workout exercises
        </Button>
        <Button render={<Link href="/recovery/versions?type=equipment_item" />} nativeButton={false} size="sm" variant={type === "equipment_item" ? "default" : "outline"}>
          <Settings2 className="size-3.5" /> Equipment
        </Button>
        <Button render={<Link href="/recovery/versions?type=exercise_equipment_fit_assertion" />} nativeButton={false} size="sm" variant={type === "exercise_equipment_fit_assertion" ? "default" : "outline"}>
          Movement compatibility
        </Button>
        <Button render={<Link href="/recovery/versions?type=constraint" />} nativeButton={false} size="sm" variant={type === "constraint" ? "default" : "outline"}>
          Constraints
        </Button>
        <Button render={<Link href="/recovery/versions?type=user_profile" />} nativeButton={false} size="sm" variant={type === "user_profile" ? "default" : "outline"}>
          Profile & coaching
        </Button>
        <Button render={<Link href="/recovery/versions?type=program" />} nativeButton={false} size="sm" variant={type === "program" ? "default" : "outline"}>
          Programs
        </Button>
        <Button render={<Link href="/recovery/versions?type=external_exercise_mapping" />} nativeButton={false} size="sm" variant={type === "external_exercise_mapping" ? "default" : "outline"}>
          Mappings
        </Button>
      </nav>

      {versions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No meaningful edits have been recorded for this filter yet.
          </CardContent>
        </Card>
      ) : (
        versions.map((version) => {
          const before = version.beforeData;
          const after = version.afterData;
          const label = recordLabel(
            version.entityType,
            before,
            after,
            exerciseNames,
            equipmentNames,
          );
          const visibleFields = version.changedFields.filter(
            (field) => !HIDDEN_TECHNICAL_FIELDS.has(field)
          );
          const correctionEvidence = readSetCorrectionEvidence(after);
          return (
            <Card key={version.id}>
              <CardHeader className="gap-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {version.action.endsWith(".version_restore") && <RotateCcw className="size-4" />}
                      {label}
                    </CardTitle>
                    <CardDescription>
                      {actionLabel(version.action)} · {version.createdAt.toLocaleString("en-CA", { timeZone: "America/Toronto" })}
                    </CardDescription>
                  </div>
                  <Badge variant="outline">
                    {entityLabel(version.entityType)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {correctionEvidence && (
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <p className="font-medium">Correction evidence</p>
                    <p className="mt-1 text-muted-foreground">
                      {correctionEvidence.category === "restore_prior_version"
                        ? "Restored an earlier retained version"
                        : correctionEvidence.category === "restore_snapshot"
                          ? "Restored the reviewed snapshot state"
                          : SET_CORRECTION_CATEGORY_LABELS[
                              correctionEvidence.category
                            ]}
                      {correctionEvidence.reasonNote
                        ? ` · ${correctionEvidence.reasonNote}`
                        : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Workout revision {correctionEvidence.sourceHistoryRevision}
                      {" → "}
                      {correctionEvidence.resultHistoryRevision} · {correctionEvidence.decisionLocalDate} in {correctionEvidence.decisionTimezone}
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {visibleFields.map((field) => (
                    <Badge key={field} variant="secondary">{fieldLabel(version.entityType, field)}</Badge>
                  ))}
                </div>
                <details className="rounded-lg border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Inspect before and after</summary>
                  <dl className="mt-3 grid gap-3">
                    {visibleFields.map((field) => (
                      <div key={field} className="grid gap-1 sm:grid-cols-[10rem_1fr_1fr] sm:gap-3">
                        <dt className="font-medium">{fieldLabel(version.entityType, field)}</dt>
                        <dd className="text-muted-foreground"><span className="sm:hidden">Before: </span>{displayValue(field, before[field], exerciseNames, equipmentNames, String(before.timezone || "America/Toronto"))}</dd>
                        <dd><span className="sm:hidden">After: </span>{displayValue(field, after[field], exerciseNames, equipmentNames, String(after.timezone || "America/Toronto"))}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
                {RESTORABLE_ENTITY_TYPES.has(version.entityType) ? (
                  <div>
                    <RestoreVersionButton
                      versionId={version.id}
                      recordLabel={label}
                      changedFields={visibleFields.map((field) => fieldLabel(version.entityType, field))}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This change is retained for inspection and complete snapshot recovery.
                    Direct single-record rollback is not offered for this setup record.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </main>
  );
}
