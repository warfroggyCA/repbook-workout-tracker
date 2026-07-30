"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveRecommendation,
  dismissRecommendationNotice,
  rejectRecommendation,
} from "@/app/actions/recommendations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Gauge, ListChecks, Minus, Plus } from "lucide-react";
import type { ReviewEvidenceItem } from "@/services/review-decisions";

export type RecommendationCardData = {
  id: string;
  ruleId: string | null;
  source: "rule" | "ai";
  exerciseName: string | null;
  reason: string;
  kind: string;
  fromLoad: number | null;
  toLoad: number | null;
  loadUnit: "lb" | "kg" | null;
  suggestedExercise: string | null;
  alternatives: string[];
  evidence: ReviewEvidenceItem[];
};

export function RecommendationCard({
  rec,
  loadStep,
}: {
  rec: RecommendationCardData;
  loadStep: number;
}) {
  const router = useRouter();
  const titleId = useId();
  const [pending, startTransition] = useTransition();
  const [editedLoad, setEditedLoad] = useState<number | null>(rec.toLoad);
  const [error, setError] = useState<string | null>(null);

  const isLoadChange = rec.kind === "load_change";
  const isHold = rec.kind === "hold";
  const edited = isLoadChange && editedLoad !== rec.toLoad;

  function decide(action: "approve" | "reject" | "dismiss") {
    setError(null);
    startTransition(async () => {
      if (action === "approve") {
        const result = await approveRecommendation({
          recommendationId: rec.id,
          editedToLoad:
            isLoadChange && editedLoad != null ? editedLoad : undefined,
        });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
      } else if (action === "reject") {
        const result = await rejectRecommendation({ recommendationId: rec.id });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
      } else {
        const result = await dismissRecommendationNotice({
          recommendationId: rec.id,
        });
        if (!result.ok) {
          router.refresh();
          setError(result.reason);
          return;
        }
      }
      router.refresh();
    });
  }

  return (
    <section
      className="rounded-xl border-2 border-primary/25 bg-card p-3 shadow-[var(--shadow-soft)] sm:p-4"
      aria-labelledby={titleId}
    >
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-primary">
            {isHold ? "Automatic status" : "Decision required"}
          </p>
          <h3 id={titleId} className="font-medium">
            {rec.exerciseName ?? "Program"}
          </h3>
        </div>
        <Badge
          variant="outline"
          className="h-auto min-h-5 max-w-full whitespace-normal break-words text-left"
        >
          {isHold ? (
            "Load held"
          ) : (
            <>
              {rec.source === "rule" ? "Deterministic rule" : "AI proposal"} ·{" "}
              {rec.ruleId?.replaceAll("_", " ") ?? rec.kind}
            </>
          )}
        </Badge>
      </div>

      {isLoadChange && (
        <p className="text-sm font-medium tabular-nums">
          {rec.fromLoad ?? "No target"} → {editedLoad ?? rec.toLoad} {rec.loadUnit}
          {edited && (
            <span className="ml-1 text-xs text-muted-foreground">(edited)</span>
          )}
        </p>
      )}
      {rec.kind === "substitution" && rec.suggestedExercise && (
        <p className="text-sm font-medium">
          Switch to: {rec.suggestedExercise}
        </p>
      )}

      <p className="mt-1 text-sm text-muted-foreground">{rec.reason}</p>

      {isHold && (
        <p className="mt-2 text-sm">
          This notice doesn&apos;t change your Program. The current load stays
          in place until the evidence window above clears.
        </p>
      )}

      {rec.alternatives.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Other options: {rec.alternatives.join(", ")}
        </p>
      )}

      <div
        className={`mt-3 grid gap-2 ${isHold ? "" : "sm:grid-cols-2"}`}
      >
        <div className="rounded-lg bg-muted/55 p-3">
          <h4 className="flex items-center gap-1.5 text-xs font-medium">
            <ListChecks className="size-3.5 text-primary" /> Evidence on record
          </h4>
          {rec.evidence.length > 0 ? (
            <dl className="mt-2 flex flex-col gap-1.5 text-xs">
              {rec.evidence.map((item) => (
                <div
                  key={`${item.label}-${item.value}`}
                  className="flex flex-wrap justify-between gap-x-3 gap-y-0.5"
                >
                  <dt className="text-muted-foreground">{item.label}</dt>
                  <dd className="font-medium tabular-nums">{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              No supporting signal details were stored with this proposal.
            </p>
          )}
        </div>
        {!isHold && (
          <div className="rounded-lg bg-muted/55 p-3">
            <h4 className="flex items-center gap-1.5 text-xs font-medium">
              <Gauge className="size-3.5 text-primary" /> Confidence
            </h4>
            <p className="mt-2 text-sm font-medium">Not scored</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This decision record contains no confidence score. Use the named
              source, rule, and evidence instead of an invented percentage.
            </p>
          </div>
        )}
      </div>

      {isLoadChange && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Adjust:</span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() =>
              setEditedLoad((l) => Math.max(0, (l ?? 0) - loadStep))
            }
            aria-label="Decrease load"
          >
            <Minus className="size-3.5" />
          </Button>
          <output
            role="status"
            aria-live="polite"
            aria-label="Adjusted load"
            className="min-w-12 text-center text-sm font-medium tabular-nums"
          >
            {editedLoad ?? "—"}
          </output>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setEditedLoad((l) => (l ?? 0) + loadStep)}
            aria-label="Increase load"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <div
        className={`mt-3 grid grid-cols-1 gap-2 ${
          isHold ? "" : "min-[22rem]:grid-cols-2"
        }`}
      >
        {!isHold && (
          <Button
            className="min-h-10 w-full"
            disabled={pending}
            onClick={() => decide("approve")}
          >
            {edited ? "Approve edited" : "Approve"}
          </Button>
        )}
        <Button
          variant="outline"
          className="min-h-10 w-full"
          disabled={pending}
          onClick={() => decide(isHold ? "dismiss" : "reject")}
        >
          {isHold ? "Dismiss notice" : "Reject"}
        </Button>
      </div>
    </section>
  );
}
