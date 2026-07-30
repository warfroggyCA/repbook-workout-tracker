import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  constraints as constraintsTable,
  programs,
  programVersions,
  workoutTemplates,
  workoutTemplateExercises,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import { isSettingsManagementEnabled } from "@/lib/settings-management-feature";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import {
  isSetupReviewSection,
  nextReviewDestination,
  type SetupReviewSectionSlug,
} from "@/lib/setup-review";
import { Button } from "@/components/ui/button";
import { ProfileForm } from "@/components/setup/profile-form";
import { ConstraintsForm } from "@/components/setup/constraints-form";
import { CoachingForm } from "@/components/setup/coaching-form";
import { SetupReviewShell } from "@/components/settings/setup-review-shell";
import { EquipmentManager } from "@/components/equipment/equipment-manager";
import { loadEquipmentInventoryDocument } from "@/services/equipment-inventory";

async function equipmentSection(
  userId: string,
  nextHref: string
) {
  const db = await getDb();
  const loaded = await loadEquipmentInventoryDocument(db, userId);
  if (!loaded) notFound();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-6 text-muted-foreground">
        Review the complete inventory below. Every saved item keeps its stable
        identity and unedited specialty details, and every change receives the
        same server-confirmed review as standalone equipment management.
      </p>
      <EquipmentManager
        initialDocument={loaded.document}
        profileUnit={loaded.profileUnit}
        definitions={loaded.definitions}
        ambiguousBarTypes={loaded.ambiguousBarTypes}
        reviewNextHref={nextHref}
        cancelHref="/settings/setup"
      />
    </div>
  );
}

async function programSection(
  userId: string,
  nextHref: string,
  reviewAll: boolean
) {
  const db = await getDb();
  const rows = await db
    .select({
      name: programs.name,
      versionNo: programVersions.versionNo,
      changeSummary: programVersions.changeSummary,
      activatedAt: programVersions.activatedAt,
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
    .where(and(eq(programs.userId, userId), eq(programs.status, "active")))
    .limit(1);
  const program = rows[0] ?? null;
  const editorEnabled = isProgramEditorEnabled();

  return (
    <div className="flex flex-col gap-4">
      {program ? (
        <div className="rounded-xl border p-4">
          <p className="text-sm font-medium">
            {program.name} · version {program.versionNo}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {program.dayCount} day{program.dayCount === 1 ? "" : "s"} ·{" "}
            {program.exerciseCount} exercise
            {program.exerciseCount === 1 ? "" : "s"}
            {program.changeSummary ? ` · ${program.changeSummary}` : ""}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          You have no active Program right now.
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Reviewing your setup never changes the Program. Real Program edits go
        through the versioned Program editor with its own review and approval.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        {program && editorEnabled && (
          <Button
            variant="outline"
            size="lg"
            className="sm:flex-1"
            render={<Link href="/program/edit" />}
            nativeButton={false}
          >
            Edit Program
          </Button>
        )}
        <Button
          size="lg"
          className="sm:flex-1"
          render={<Link href={reviewAll ? "/settings" : nextHref} />}
          nativeButton={false}
        >
          {reviewAll ? "Finish review" : "Back to summary"}
        </Button>
      </div>
    </div>
  );
}

/**
 * One returning-user review section (UI-007). Each section loads fresh
 * durable state and saves only its own subject; there is no combined
 * returning-user setup draft.
 */
export default async function SetupReviewSectionPage(
  props: PageProps<"/settings/setup/[section]">
) {
  if (!isSettingsManagementEnabled()) notFound();
  const [{ section }, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  if (!isSetupReviewSection(section)) notFound();
  const user = await getCurrentUser();
  if (user.profile.setupCompletedAt == null) {
    redirect("/setup");
  }
  const reviewAll = searchParams.flow === "all";
  const slug = section as SetupReviewSectionSlug;
  const nextHref = nextReviewDestination(slug, reviewAll);
  const review = { mode: "review" as const, nextHref };

  let body: React.ReactNode;
  switch (slug) {
    case "profile":
      body = <ProfileForm profile={user.profile} review={review} />;
      break;
    case "equipment":
      body = await equipmentSection(user.id, nextHref);
      break;
    case "constraints": {
      const db = await getDb();
      const rows = await db.query.constraints.findMany({
        where: eq(constraintsTable.userId, user.id),
      });
      body = <ConstraintsForm existing={rows} review={review} />;
      break;
    }
    case "coaching":
      body = <CoachingForm prefs={user.profile.coachingPrefs} review={review} />;
      break;
    case "program":
      body = await programSection(user.id, nextHref, reviewAll);
      break;
  }

  return (
    <SetupReviewShell section={slug} reviewAll={reviewAll}>
      {body}
    </SetupReviewShell>
  );
}
