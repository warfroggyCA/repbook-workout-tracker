import Link from "next/link";
import { Button } from "@/components/ui/button";
import { GOALS } from "@/lib/setup-steps";

export type SetupReviewSummaryData = {
  profile: {
    experience: string;
    goals: string[];
    sessionLengthMin: number;
    weeklyFrequency: number;
    unit: "lb" | "kg";
  };
  equipment: {
    itemCount: number;
    familyCount: number;
    plateDenominations: number;
    barConfigurations: number;
  };
  constraints: Array<{ bodyPart: string; avoid: boolean }>;
  coaching: {
    aggressiveness: string;
    deloadSuggestions: boolean;
    substitutionSuggestions: boolean;
    weeklyReview: boolean;
  };
  program: {
    name: string;
    versionNo: number;
    dayCount: number;
    exerciseCount: number;
  } | null;
};

function SummaryCard({
  title,
  reviewHref,
  reviewLabel,
  children,
}: {
  title: string;
  reviewHref: string;
  reviewLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-[var(--shadow-soft)]">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          render={<Link href={reviewHref} />}
          nativeButton={false}
        >
          {reviewLabel}
        </Button>
      </div>
      <div className="text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

/**
 * Current-state setup summary (UI-007). Every value comes from durable saved
 * state — never from the first-time onboarding routine draft — and there is
 * deliberately no Activate Program action anywhere in this experience.
 */
export function SetupReviewSummary({ data }: { data: SetupReviewSummaryData }) {
  const goalLabels = data.profile.goals.map(
    (goal) => GOALS.find((entry) => entry.id === goal)?.label ?? goal
  );
  const avoided = data.constraints.filter((row) => row.avoid);
  const cautious = data.constraints.filter((row) => !row.avoid);

  return (
    <div className="flex flex-col gap-3">
      <SummaryCard
        title="Profile"
        reviewHref="/settings/setup/profile"
        reviewLabel="Review profile"
      >
        <p>
          {data.profile.experience} · {data.profile.weeklyFrequency}×/week ·{" "}
          {data.profile.sessionLengthMin} min · {data.profile.unit}
        </p>
        <p>{goalLabels.length ? goalLabels.join(", ") : "No goals recorded"}</p>
      </SummaryCard>

      <SummaryCard
        title="Equipment"
        reviewHref="/settings/equipment"
        reviewLabel="Manage equipment"
      >
        <p>
          {data.equipment.itemCount} item
          {data.equipment.itemCount === 1 ? "" : "s"} across{" "}
          {data.equipment.familyCount} famil
          {data.equipment.familyCount === 1 ? "y" : "ies"}
          {data.equipment.plateDenominations > 0
            ? ` · ${data.equipment.plateDenominations} plate size${
                data.equipment.plateDenominations === 1 ? "" : "s"
              }`
            : ""}
          {data.equipment.barConfigurations > 0
            ? ` · ${data.equipment.barConfigurations} bar configuration${
                data.equipment.barConfigurations === 1 ? "" : "s"
              }`
            : ""}
        </p>
      </SummaryCard>

      <SummaryCard
        title="Constraints"
        reviewHref="/settings/setup/constraints"
        reviewLabel="Review constraints"
      >
        {data.constraints.length === 0 ? (
          <p>Nothing flagged.</p>
        ) : (
          <p>
            {avoided.length > 0 &&
              `Avoiding around: ${[...new Set(avoided.map((row) => row.bodyPart))].join(", ")}. `}
            {cautious.length > 0 &&
              `Cautious around: ${[...new Set(cautious.map((row) => row.bodyPart))].join(", ")}.`}
          </p>
        )}
      </SummaryCard>

      <SummaryCard
        title="Coaching preferences"
        reviewHref="/settings/setup/coaching"
        reviewLabel="Review coaching"
      >
        <p>
          {data.coaching.aggressiveness} progression ·{" "}
          {[
            data.coaching.deloadSuggestions ? "deload suggestions" : null,
            data.coaching.substitutionSuggestions ? "substitutions" : null,
            data.coaching.weeklyReview ? "weekly review" : null,
          ]
            .filter(Boolean)
            .join(", ") || "all suggestions off"}
        </p>
      </SummaryCard>

      <SummaryCard
        title="Current Program"
        reviewHref="/settings/setup/program"
        reviewLabel="Review Program"
      >
        {data.program ? (
          <p>
            {data.program.name} · v{data.program.versionNo} ·{" "}
            {data.program.dayCount} day{data.program.dayCount === 1 ? "" : "s"} ·{" "}
            {data.program.exerciseCount} exercise
            {data.program.exerciseCount === 1 ? "" : "s"}
          </p>
        ) : (
          <p>No active Program.</p>
        )}
      </SummaryCard>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          size="lg"
          className="sm:flex-1"
          render={<Link href="/settings/setup/profile?flow=all" />}
          nativeButton={false}
        >
          Review all
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="sm:flex-1"
          render={<Link href="/settings" />}
          nativeButton={false}
        >
          Back to Settings
        </Button>
      </div>
    </div>
  );
}
