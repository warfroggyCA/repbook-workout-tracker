"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CoachingPrefs } from "@/db/schema/user";
import { saveCoachingPrefs } from "@/app/actions/setup";
import { saveCoachingReview } from "@/app/actions/settings-review";
import type { SetupReviewFormContext } from "@/lib/setup-review";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, PillGroup } from "@/components/setup/profile-form";

const TOGGLES: Array<{
  key: keyof Omit<CoachingPrefs, "aggressiveness">;
  label: string;
  hint: string;
}> = [
  {
    key: "deloadSuggestions",
    label: "Deload suggestions",
    hint: "Suggest an easier week after grindy sessions or long gaps.",
  },
  {
    key: "substitutionSuggestions",
    label: "Substitution suggestions",
    hint: "Offer equipment-aware swaps when something hurts or is busy.",
  },
  {
    key: "weeklyReview",
    label: "Weekly review",
    hint: "A short summary of the week with proposed tweaks to approve.",
  },
];

export function CoachingForm({
  prefs,
  review,
}: {
  prefs: CoachingPrefs;
  review?: SetupReviewFormContext;
}) {
  const router = useRouter();
  const [state, setState] = useState<CoachingPrefs>(prefs);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = JSON.stringify(state) !== JSON.stringify(prefs);

  function handleSave() {
    setError(null);
    if (review && !dirty) {
      // Reviewing without changes is read-only: nothing is written at all.
      router.push(review.nextHref);
      return;
    }
    startTransition(async () => {
      const result = review
        ? await saveCoachingReview(state)
        : await saveCoachingPrefs(state);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.push(review ? review.nextHref : "/setup/review");
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Field label="Progression aggressiveness">
        <PillGroup
          options={["conservative", "moderate", "aggressive"] as const}
          selected={[state.aggressiveness]}
          onToggle={(v) => setState((s) => ({ ...s, aggressiveness: v }))}
          labels={{
            conservative: "Conservative",
            moderate: "Moderate",
            aggressive: "Aggressive",
          }}
        />
        <p className="text-xs text-muted-foreground">
          Conservative is the recommendation: small jumps, deloads when in
          doubt. Every change still needs your approval.
        </p>
      </Field>

      {TOGGLES.map((t) => (
        <label
          key={t.key}
          className="flex items-center justify-between gap-3 rounded-xl border p-3"
        >
          <span>
            <span className="block text-sm font-medium">{t.label}</span>
            <span className="block text-xs text-muted-foreground">{t.hint}</span>
          </span>
          <Switch
            checked={state[t.key]}
            onCheckedChange={(checked) =>
              setState((s) => ({ ...s, [t.key]: checked }))
            }
          />
        </label>
      ))}

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
