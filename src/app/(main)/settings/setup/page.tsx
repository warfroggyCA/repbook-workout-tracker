import { notFound, redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  barbellConfigs,
  constraints as constraintsTable,
  equipmentItems,
  plateInventory,
  programs,
  programVersions,
  workoutTemplates,
  workoutTemplateExercises,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import { isSettingsManagementEnabled } from "@/lib/settings-management-feature";
import { familyForEquipmentType } from "@/lib/equipment-families";
import {
  SetupReviewSummary,
  type SetupReviewSummaryData,
} from "@/components/settings/setup-review-summary";

/**
 * Returning-user setup review hub (UI-007). A current-state summary of the
 * original setup subjects using durable saved data only. It never reads the
 * onboarding routine draft and never offers Program activation.
 */
export default async function SetupReviewPage() {
  if (!isSettingsManagementEnabled()) notFound();
  const user = await getCurrentUser();
  if (user.profile.setupCompletedAt == null) {
    // First-time accounts keep the guided onboarding sequence.
    redirect("/setup");
  }
  const db = await getDb();

  const [items, plates, bars, constraintRows, programRows] = await Promise.all([
    db.query.equipmentItems.findMany({
      where: and(eq(equipmentItems.userId, user.id), eq(equipmentItems.available, true)),
      columns: { id: true, type: true },
    }),
    db.query.plateInventory.findMany({
      where: eq(plateInventory.userId, user.id),
      columns: { id: true },
    }),
    db.query.barbellConfigs.findMany({
      where: eq(barbellConfigs.userId, user.id),
      columns: { id: true },
    }),
    db.query.constraints.findMany({
      where: eq(constraintsTable.userId, user.id),
      columns: { bodyPart: true, avoid: true },
    }),
    db
      .select({
        name: programs.name,
        versionNo: programVersions.versionNo,
        dayCount: sql<number>`(
          SELECT count(*)::int FROM ${workoutTemplates}
          WHERE ${workoutTemplates.programVersionId} = ${programVersions.id}
        )`,
        exerciseCount: sql<number>`(
          SELECT count(*)::int FROM ${workoutTemplateExercises}
          JOIN ${workoutTemplates}
            ON ${workoutTemplates.id} = ${workoutTemplateExercises.workoutTemplateId}
          WHERE ${workoutTemplates.programVersionId} = ${programVersions.id}
        )`,
      })
      .from(programs)
      .innerJoin(programVersions, eq(programVersions.id, programs.currentVersionId))
      .where(and(eq(programs.userId, user.id), eq(programs.status, "active")))
      .limit(1),
  ]);

  const data: SetupReviewSummaryData = {
    profile: {
      experience: user.profile.experience,
      goals: user.profile.goals,
      sessionLengthMin: user.profile.sessionLengthMin,
      weeklyFrequency: user.profile.weeklyFrequency,
      unit: user.profile.unit,
    },
    equipment: {
      itemCount:
        items.filter((item) => item.type !== "plates" && item.type !== "bodyweight")
          .length + (plates.length > 0 ? 1 : 0),
      familyCount: new Set([
        ...items
          .filter((item) => item.type !== "plates" && item.type !== "bodyweight")
          .map((item) => familyForEquipmentType(item.type)),
        ...(plates.length > 0 ? (["bars_and_plates"] as const) : []),
      ]).size,
      plateDenominations: plates.length,
      barConfigurations: bars.length,
    },
    constraints: constraintRows,
    coaching: user.profile.coachingPrefs,
    program: programRows[0] ?? null,
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Review setup
        </h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          This is your current saved setup. Review any subject on its own, or
          walk through everything. Nothing changes unless you save a section,
          and Program edits go through the Program editor.
        </p>
      </header>
      <SetupReviewSummary data={data} />
    </main>
  );
}
