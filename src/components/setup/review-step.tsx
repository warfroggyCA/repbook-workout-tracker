import Link from "next/link";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  constraints as constraintsTable,
  exerciseEquipmentRequirements,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import { GOALS, PATTERN_LABELS } from "@/lib/setup-steps";
import { Badge } from "@/components/ui/badge";
import { ActivateButton } from "@/components/setup/activate-button";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
} from "@/lib/program-document";
import { loadEquipmentInventoryDocument } from "@/services/equipment-inventory";
import { createSetupEquipmentFitReviewToken } from "@/services/setup-equipment-fit-review";
import { loadOwnerEquipmentFitReviewRevision } from "@/services/equipment-fit-review-revision";

function Section({
  title,
  editHref,
  children,
}: {
  title: string;
  editHref: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        <Link href={editHref} className="text-xs text-primary underline">
          Edit
        </Link>
      </div>
      {children}
    </section>
  );
}

/** Read-only summary of everything; activation creates ProgramVersion v1. */
export async function ReviewStep() {
  const user = await getCurrentUser();
  const db = await getDb();
  const profile = user.profile;

  const draft = profile.setupState.routineDraft;
  const draftExerciseIds = [...new Set(
    draft?.days.flatMap((day) => day.exercises.map((exercise) => exercise.exerciseId)) ?? [],
  )];
  const [inventory, constraintRows, itemFitRequirements, equipmentFitReviewRevision] = await Promise.all([
    loadEquipmentInventoryDocument(db, user.id),
    db.query.constraints.findMany({
      where: eq(constraintsTable.userId, user.id),
    }),
    draftExerciseIds.length === 0
      ? Promise.resolve([])
      : db.select({ exerciseId: exerciseEquipmentRequirements.exerciseId })
        .from(exerciseEquipmentRequirements)
        .where(and(
          inArray(exerciseEquipmentRequirements.exerciseId, draftExerciseIds),
          notInArray(exerciseEquipmentRequirements.equipmentType, ["bodyweight", "plates"]),
        )),
    loadOwnerEquipmentFitReviewRevision(db, user.id),
  ]);
  if (!inventory || !equipmentFitReviewRevision) return null;
  const equipment = inventory.document.items;
  const equipmentFitReviewToken = createSetupEquipmentFitReviewToken({
    routineDraft: draft,
    equipmentFitReviewRevision,
  });
  const goalLabels = profile.goals.map(
    (g) => GOALS.find((x) => x.id === g)?.label ?? g
  );

  return (
    <div className="flex flex-col gap-3">
      <Section title="Profile" editHref="/setup/profile">
        <p className="text-sm text-muted-foreground">
          {profile.ageRange ?? "—"} · {profile.experience} ·{" "}
          {goalLabels.join(", ") || "no goals"} · {profile.sessionLengthMin} min
          × {profile.weeklyFrequency}/week · {profile.unit}
        </p>
      </Section>

      <Section title="Equipment" editHref="/setup/equipment">
        {equipment.length ? (
          <div className="flex flex-wrap gap-1.5">
            {equipment.map((e) => (
              <Badge key={e.id} variant="outline">
                {e.label}
                {e.quantity > 1 ? ` ×${e.quantity}` : ""}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No equipment saved.</p>
        )}
      </Section>

      <Section title="Constraints" editHref="/setup/constraints">
        {constraintRows.length ? (
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {constraintRows.map((c) => (
              <li key={c.id}>
                <span className="capitalize text-foreground">{c.bodyPart}</span>{" "}
                — {c.avoid ? "avoid" : "cautious"}:{" "}
                {c.affectedPatterns
                  .map((p) => PATTERN_LABELS[p] ?? p)
                  .join(", ")}{" "}
                · stop at pain ≥{c.painStopThreshold}/10
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None flagged.</p>
        )}
      </Section>

      <Section title="Routine" editHref="/setup/routine">
        {draft?.days.length ? (
          <div className="flex flex-col gap-2">
            {draft.days.map((day, i) => (
              <div key={i}>
                <p className="text-sm font-medium">{day.name}</p>
                <ul className="text-sm text-muted-foreground">
                  {day.exercises.map((ex, j) => (
                    <li key={j} className="flex justify-between py-0.5">
                      <span>
                        {ex.name}
                        {ex.supersetGroup ? ` (SS ${ex.supersetGroup})` : ""}
                      </span>
                      <span className="tabular-nums">
                        {ex.sets}×{ex.repMin}–{ex.repMax}
                        {ex.targetLoad != null
                          ? ` @ ${ex.targetLoad} ${ex.targetLoadUnit ?? "unit missing"}`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-destructive">
            No routine yet — build one in step 4 before activating.
          </p>
        )}
      </Section>

      <Section title="Structured training intent" editHref="/setup/routine">
        <p className="mb-2 text-xs text-muted-foreground">These structured suggestions will be published only when you activate. They are not inferred from training history.</p>
        {draft?.days.map((day, dayIndex) => {
          const intent = createSuggestedDayIntent(day.exercises.map((exercise, exerciseIndex) => ({
            lineageId: `preview-${dayIndex}-${exerciseIndex}`,
            sets: exercise.sets,
            restSec: exercise.restSec,
          })));
          return (
            <div key={`${day.name}-${dayIndex}`} className="mb-2 text-sm last:mb-0">
              <p className="font-medium">{day.name}: strength · anchor-led identity · target {intent.targetDuration.minMinutes}–{intent.targetDuration.maxMinutes} min · minimum useful {intent.minimumUsefulDurationMinutes} min</p>
              <ul className="text-xs text-muted-foreground">
                {day.exercises.map((exercise, exerciseIndex) => {
                  const slotIntent = createSuggestedSlotIntent(exercise.sets, exerciseIndex);
                  return <li key={`${exercise.exerciseId}-${exerciseIndex}`}>{exercise.name}: {slotIntent.role} · {slotIntent.priority} · minimum {slotIntent.minimumDose.value} sets · ideal {slotIntent.idealDose.value} · {slotIntent.substitutionPolicy.replaceAll("_", " ")} · omission {slotIntent.omissionPolicy.replaceAll("_", " ")}</li>;
                })}
              </ul>
            </div>
          );
        })}
      </Section>

      <Section title="Coaching" editHref="/setup/coaching">
        <p className="text-sm text-muted-foreground">
          {profile.coachingPrefs.aggressiveness} progression ·{" "}
          {profile.coachingPrefs.deloadSuggestions ? "deloads on" : "deloads off"}{" "}
          ·{" "}
          {profile.coachingPrefs.substitutionSuggestions
            ? "substitutions on"
            : "substitutions off"}{" "}
          ·{" "}
          {profile.coachingPrefs.weeklyReview
            ? "weekly review on"
            : "weekly review off"}
        </p>
      </Section>

      <ActivateButton
        disabled={!draft?.days.length}
        requiresEquipmentFitReview={itemFitRequirements.length > 0}
        equipmentFitReviewToken={equipmentFitReviewToken}
      />
    </div>
  );
}
