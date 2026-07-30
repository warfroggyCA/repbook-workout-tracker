"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { userProfiles } from "@/db/schema";
import { saveProfileStep } from "@/app/actions/setup";
import { saveProfileReview } from "@/app/actions/settings-review";
import { AGE_RANGES, GOALS } from "@/lib/setup-steps";
import type { SetupReviewFormContext } from "@/lib/setup-review";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Profile = typeof userProfiles.$inferSelect;

/** Pill-style single/multi select used across the wizard forms. */
export function PillGroup<T extends string>({
  options,
  selected,
  onToggle,
  labels,
}: {
  options: readonly T[];
  selected: T[];
  onToggle: (value: T) => void;
  labels?: Partial<Record<T, string>>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onToggle(opt)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm transition-colors",
            selected.includes(opt)
              ? "border-primary bg-primary text-primary-foreground"
              : "bg-background text-foreground"
          )}
        >
          {labels?.[opt] ?? opt}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

export function ProfileForm({
  profile,
  review,
}: {
  profile: Profile;
  review?: SetupReviewFormContext;
}) {
  const router = useRouter();
  const [ageRange, setAgeRange] = useState(profile.ageRange ?? "");
  const [experience, setExperience] = useState(profile.experience);
  const [goals, setGoals] = useState<string[]>(profile.goals);
  const [sessionLength, setSessionLength] = useState(profile.sessionLengthMin);
  const [frequency, setFrequency] = useState(profile.weeklyFrequency);
  const [unit, setUnit] = useState(profile.unit);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    ageRange !== (profile.ageRange ?? "") ||
    experience !== profile.experience ||
    JSON.stringify([...goals].sort()) !==
      JSON.stringify([...profile.goals].sort()) ||
    sessionLength !== profile.sessionLengthMin ||
    frequency !== profile.weeklyFrequency;

  function handleSave() {
    if (!ageRange) {
      setError("Pick an age range.");
      return;
    }
    if (!goals.length) {
      setError("Pick at least one goal.");
      return;
    }
    setError(null);
    if (review && !dirty) {
      // Reviewing without changes is read-only: nothing is written at all.
      router.push(review.nextHref);
      return;
    }
    startTransition(async () => {
      const payload = {
        ageRange,
        experience,
        goals: goals as ("strength" | "tone" | "consistency")[],
        sessionLengthMin: sessionLength,
        weeklyFrequency: frequency,
      };
      const result = review
        ? await saveProfileReview(payload)
        : await saveProfileStep({ ...payload, unit });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.push(review ? review.nextHref : "/setup/equipment");
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Field label="Age range">
        <PillGroup
          options={AGE_RANGES}
          selected={ageRange ? [ageRange as (typeof AGE_RANGES)[number]] : []}
          onToggle={(v) => setAgeRange(v)}
        />
      </Field>

      <Field label="Lifting experience">
        <PillGroup
          options={["novice", "intermediate", "advanced"] as const}
          selected={[experience]}
          onToggle={(v) => setExperience(v)}
          labels={{
            novice: "Novice",
            intermediate: "Intermediate",
            advanced: "Advanced",
          }}
        />
      </Field>

      <Field label="Goals (pick any)">
        <PillGroup
          options={GOALS.map((g) => g.id)}
          selected={goals as (typeof GOALS)[number]["id"][]}
          onToggle={(v) =>
            setGoals((g) => (g.includes(v) ? g.filter((x) => x !== v) : [...g, v]))
          }
          labels={Object.fromEntries(GOALS.map((g) => [g.id, g.label]))}
        />
      </Field>

      <Field label={`Session length: ${sessionLength} min`}>
        <input
          type="range"
          min={15}
          max={120}
          step={5}
          value={sessionLength}
          onChange={(e) => setSessionLength(Number(e.target.value))}
        />
      </Field>

      <Field label={`Workouts per week: ${frequency}`}>
        <input
          type="range"
          min={1}
          max={7}
          value={frequency}
          onChange={(e) => setFrequency(Number(e.target.value))}
        />
      </Field>

      {review ? (
        <Field label="Units">
          <p className="text-sm">
            {profile.unit === "lb" ? "Pounds (lb)" : "Kilograms (kg)"}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            The account unit is read-only here. Your saved plates and bars are
            recorded in this unit, so changing it safely needs a separate
            conversion step that does not exist yet.
          </p>
        </Field>
      ) : (
        <Field label="Units">
          <PillGroup
            options={["lb", "kg"] as const}
            selected={[unit]}
            onToggle={(v) => setUnit(v)}
            labels={{ lb: "Pounds (lb)", kg: "Kilograms (kg)" }}
          />
        </Field>
      )}

      {error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <Button size="lg" disabled={pending} onClick={handleSave}>
        {pending
          ? "Saving…"
          : review
            ? dirty
              ? "Save and continue"
              : "Continue without changes"
            : "Continue"}
      </Button>
    </div>
  );
}
