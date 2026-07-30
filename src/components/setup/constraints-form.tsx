"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { constraints } from "@/db/schema";
import { saveSetupConstraints } from "@/app/actions/setup";
import { saveConstraintsReview } from "@/app/actions/settings-review";
import type { SetupReviewFormContext } from "@/lib/setup-review";
import { BODY_REGION_PATTERNS, PATTERN_LABELS } from "@/lib/setup-steps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ConstraintRow = typeof constraints.$inferSelect;
type PatternMode = "ok" | "cautious" | "avoid";

type RegionState = {
  enabled: boolean;
  modes: Record<string, PatternMode>;
  painStopThreshold: number;
  note: string;
};

const REGIONS = Object.keys(BODY_REGION_PATTERNS);

function initialState(existing: ConstraintRow[]): Record<string, RegionState> {
  const state: Record<string, RegionState> = {};
  for (const region of REGIONS) {
    const rows = existing.filter((r) => r.bodyPart === region);
    const modes: Record<string, PatternMode> = {};
    for (const pattern of BODY_REGION_PATTERNS[region]) {
      // Default for an enabled region: cautious — the conservative choice.
      modes[pattern] = "cautious";
      for (const row of rows) {
        if (row.affectedPatterns.includes(pattern)) {
          modes[pattern] = row.avoid ? "avoid" : "cautious";
        }
      }
    }
    state[region] = {
      enabled: rows.length > 0,
      modes,
      painStopThreshold: rows[0]?.painStopThreshold ?? 3,
      note: rows[0]?.note ?? "",
    };
  }
  return state;
}

function regionsPayload(state: Record<string, RegionState>) {
  return REGIONS.filter((r) => state[r].enabled).map((r) => {
    const rs = state[r];
    const patterns = BODY_REGION_PATTERNS[r];
    return {
      bodyPart: r,
      avoidPatterns: patterns.filter((p) => rs.modes[p] === "avoid"),
      cautiousPatterns: patterns.filter((p) => rs.modes[p] === "cautious"),
      painStopThreshold: rs.painStopThreshold,
      note: rs.note.trim() || null,
    };
  });
}

export function ConstraintsForm({
  existing,
  review,
}: {
  existing: ConstraintRow[];
  review?: SetupReviewFormContext;
}) {
  const router = useRouter();
  const [state, setState] = useState(() => initialState(existing));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    JSON.stringify(regionsPayload(state)) !==
    JSON.stringify(regionsPayload(initialState(existing)));

  function update(region: string, patch: Partial<RegionState>) {
    setState((s) => ({ ...s, [region]: { ...s[region], ...patch } }));
  }

  function handleSave() {
    setError(null);
    if (review && !dirty) {
      // Reviewing without changes is read-only: nothing is written at all.
      router.push(review.nextHref);
      return;
    }
    startTransition(async () => {
      const regions = regionsPayload(state);
      const result = review
        ? await saveConstraintsReview({ regions })
        : await saveSetupConstraints({ regions });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.push(review ? review.nextHref : "/setup/routine");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Anything the coach should work around? Toggle a body region and set how
        each movement pattern is treated. Skip this if nothing applies.
      </p>

      {REGIONS.map((region) => {
        const rs = state[region];
        return (
          <div
            key={region}
            className={cn("rounded-xl border", rs.enabled && "border-primary/40")}
          >
            <button
              type="button"
              className="flex w-full items-center justify-between p-3 text-left text-sm font-medium capitalize"
              onClick={() => update(region, { enabled: !rs.enabled })}
            >
              {region}
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-[4px] border text-[10px]",
                  rs.enabled && "border-primary bg-primary text-primary-foreground"
                )}
              >
                {rs.enabled ? "✓" : ""}
              </span>
            </button>

            {rs.enabled && (
              <div className="flex flex-col gap-2 px-3 pb-3">
                {BODY_REGION_PATTERNS[region].map((pattern) => (
                  <div
                    key={pattern}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {PATTERN_LABELS[pattern] ?? pattern}
                    </span>
                    <div className="flex shrink-0 gap-1">
                      {(["ok", "cautious", "avoid"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() =>
                            update(region, {
                              modes: { ...rs.modes, [pattern]: mode },
                            })
                          }
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-xs capitalize",
                            rs.modes[pattern] === mode &&
                              (mode === "avoid"
                                ? "border-destructive bg-destructive text-white"
                                : mode === "cautious"
                                  ? "border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                  : "border-primary bg-primary text-primary-foreground")
                          )}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}

                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Stop a set at pain ≥
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={rs.painStopThreshold}
                    onChange={(e) =>
                      update(region, { painStopThreshold: Number(e.target.value) })
                    }
                  />
                  <span className="font-medium text-foreground">
                    {rs.painStopThreshold}/10
                  </span>
                </label>

                <Input
                  placeholder="Note (optional), e.g. old rotator cuff strain"
                  className="h-8 text-sm"
                  value={rs.note}
                  onChange={(e) => update(region, { note: e.target.value })}
                />
              </div>
            )}
          </div>
        );
      })}

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
            : REGIONS.some((r) => state[r].enabled)
              ? "Save & continue"
              : "Nothing to flag — continue"}
      </Button>
    </div>
  );
}
