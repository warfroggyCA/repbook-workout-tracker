import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq, isNull, or } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import {
  barbellConfigs,
  constraints as constraintsTable,
  equipmentItems,
  exercises,
  plateInventory,
} from "@/db/schema";
import { getCurrentUser, type CurrentUser } from "@/lib/user";
import {
  SETUP_STEPS,
  isSetupStep,
  stepIndex,
  type SetupStepSlug,
} from "@/lib/setup-steps";
import { cn } from "@/lib/utils";
import { isAIAvailable } from "@/ai/provider";
import { ProfileForm } from "@/components/setup/profile-form";
import { EquipmentStep } from "@/components/setup/equipment-step";
import { ConstraintsForm } from "@/components/setup/constraints-form";
import { RoutineBuilder } from "@/components/setup/routine-builder";
import { getExerciseDiscoveryLibrary } from "@/services/exercise-discovery";
import { CoachingForm } from "@/components/setup/coaching-form";
import { ReviewStep } from "@/components/setup/review-step";
import { completedSetupRedirectTarget } from "@/lib/settings-management-feature";

async function stepBody(db: Db, user: CurrentUser, step: SetupStepSlug) {
  switch (step) {
    case "profile":
      return <ProfileForm profile={user.profile} />;
    case "equipment": {
      const [items, plates, bars] = await Promise.all([
        db.query.equipmentItems.findMany({
          where: and(
            eq(equipmentItems.userId, user.id),
            eq(equipmentItems.available, true)
          ),
        }),
        db.query.plateInventory.findMany({
          where: eq(plateInventory.userId, user.id),
        }),
        db.query.barbellConfigs.findMany({
          where: eq(barbellConfigs.userId, user.id),
        }),
      ]);
      return (
        <EquipmentStep
          profileUnit={user.profile.unit}
          aiAvailable={isAIAvailable()}
          existing={{ items, plates, bars }}
        />
      );
    }
    case "constraints": {
      const rows = await db.query.constraints.findMany({
        where: eq(constraintsTable.userId, user.id),
      });
      return <ConstraintsForm existing={rows} />;
    }
    case "routine": {
      const [exerciseRows, exerciseLibrary] = await Promise.all([
        db.query.exercises.findMany({
          where: or(eq(exercises.userId, user.id), isNull(exercises.userId)),
        }),
        getExerciseDiscoveryLibrary(db, user.id),
      ]);
      return (
        <RoutineBuilder
          draft={user.profile.setupState.routineDraft}
          unit={user.profile.unit}
          aiAvailable={isAIAvailable()}
          exerciseMetadata={Object.fromEntries(
            exerciseRows.map((exercise) => [
              exercise.id,
              {
                movementPattern: exercise.movementPattern,
                primaryMuscles: exercise.primaryMuscles,
              },
            ])
          )}
          exerciseLibrary={exerciseLibrary}
        />
      );
    }
    case "coaching":
      return <CoachingForm prefs={user.profile.coachingPrefs} />;
    case "review":
      return <ReviewStep />;
  }
}

export default async function SetupStepPage(props: PageProps<"/setup/[step]">) {
  const { step } = await props.params;

  const user = await getCurrentUser();
  // Completed accounts never re-enter first-time onboarding, including any
  // direct step address. They review through Settings instead.
  if (user.profile.setupCompletedAt != null) {
    redirect(completedSetupRedirectTarget());
  }
  if (!isSetupStep(step)) notFound();
  const db = await getDb();
  const idx = stepIndex(step);
  const body = await stepBody(db, user, step);

  return (
    <main className="flex flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header className={cn(step === "routine" ? "" : "max-w-2xl")}>
        <p className="text-xs text-muted-foreground">
          Set up · step {idx + 1} of {SETUP_STEPS.length}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {SETUP_STEPS[idx].title}
        </h1>
        <nav className="mt-2 flex gap-1.5" aria-label="Setup progress">
          {SETUP_STEPS.map((s, i) => {
            const done = user.profile.setupState.completedSteps.includes(s.slug);
            const reachable = done || i <= idx;
            const dot = (
              <span
                className={cn(
                  "block h-1.5 w-full rounded-full",
                  i === idx ? "bg-primary" : done ? "bg-primary/40" : "bg-muted"
                )}
              />
            );
            return reachable ? (
              <Link
                key={s.slug}
                href={`/setup/${s.slug}`}
                className="flex-1"
                title={s.title}
              >
                {dot}
              </Link>
            ) : (
              <span key={s.slug} className="flex-1" title={s.title}>
                {dot}
              </span>
            );
          })}
        </nav>
      </header>

      <div className={cn(step === "routine" ? "" : "max-w-2xl")}>{body}</div>
    </main>
  );
}
