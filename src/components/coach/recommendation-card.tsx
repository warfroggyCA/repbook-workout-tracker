"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  approveRecommendation,
  deferRecommendation,
  dismissRecommendationNotice,
  rejectRecommendation,
  resumeRecommendation,
} from "@/app/actions/recommendations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CalendarClock, ExternalLink, Gauge, ListChecks, Minus, Plus } from "lucide-react";
import type { ReviewEvidenceItem } from "@/services/review-decisions";
import type { ReviewEvidenceLink, ReviewEvidenceState } from "@/services/review-evidence";

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
  reviewRevision: number;
  deferRevision: number;
  deferredAt: string | null;
  revisitOn: string | null;
  deferReason: string | null;
  createdAt: string;
  createdAtLabel: string;
  evidenceState: ReviewEvidenceState;
  evidenceExplanation: string;
  evidenceLinks: ReviewEvidenceLink[];
  actionable: boolean;
  producer: "progression_rules" | "pain_consistency" | "external_analysis" | null;
  sourceVersion: string | null;
  generatedAt: string | null;
  limitations: string[];
  proposedEffect: string;
  externalRequestedOutcome: string | null;
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
  const [revisitOn, setRevisitOn] = useState(rec.revisitOn ?? "");
  const [deferReason, setDeferReason] = useState(rec.deferReason ?? "");
  const [externalOutcome, setExternalOutcome] = useState(rec.externalRequestedOutcome ?? "");
  const [error, setError] = useState<string | null>(null);

  const isLoadChange = rec.kind === "load_change";
  const isHold = rec.kind === "hold";
  const isExternal = rec.kind === "external_review";
  const edited = isLoadChange && editedLoad !== rec.toLoad;
  const externalEdited =
    isExternal && externalOutcome.trim() !== rec.externalRequestedOutcome;
  const deferred = rec.deferredAt != null;

  function decide(action: "approve" | "reject" | "dismiss" | "defer" | "resume") {
    setError(null);
    startTransition(async () => {
      if (action === "approve") {
        const result = await approveRecommendation({
          recommendationId: rec.id,
          expectedReviewRevision: rec.reviewRevision,
          expectedDeferRevision: rec.deferRevision,
          editedToLoad:
            isLoadChange && editedLoad != null ? editedLoad : undefined,
          editedRequestedOutcome:
            isExternal && externalOutcome.trim()
              ? externalOutcome.trim()
              : undefined,
        });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
      } else if (action === "reject") {
        const result = await rejectRecommendation({
          recommendationId: rec.id,
          expectedReviewRevision: rec.reviewRevision,
          expectedDeferRevision: rec.deferRevision,
        });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
      } else if (action === "dismiss") {
        const result = await dismissRecommendationNotice({
          recommendationId: rec.id,
        });
        if (!result.ok) {
          router.refresh();
          setError(result.reason);
          return;
        }
      } else if (action === "defer") {
        const result = await deferRecommendation({
          recommendationId: rec.id,
          expectedReviewRevision: rec.reviewRevision,
          expectedDeferRevision: rec.deferRevision,
          revisitOn: revisitOn || undefined,
          reason: deferReason || undefined,
        });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
      } else {
        const result = await resumeRecommendation({
          recommendationId: rec.id,
          expectedReviewRevision: rec.reviewRevision,
          expectedDeferRevision: rec.deferRevision,
        });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setRevisitOn("");
        setDeferReason("");
      }
      router.refresh();
    });
  }

  return (
    <section
      id={`recommendation-${rec.id}`}
      className="rounded-xl border-2 border-primary/25 bg-card p-3 shadow-[var(--shadow-soft)] sm:p-4"
      aria-labelledby={titleId}
    >
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-primary">
            {isHold ? "Automatic status" : isExternal ? "External AI proposal · you decide" : "Decision required"}
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

      {isLoadChange && !deferred && rec.actionable && (
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

      <div className="mt-3 rounded-lg border bg-muted/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wide">Review evidence</h4>
          <Badge variant={rec.evidenceState === "supported" || rec.evidenceState === "external" ? "secondary" : "outline"}>
            {rec.evidenceState === "supported"
              ? "Supported"
              : rec.evidenceState === "external"
                ? "Validated external"
              : rec.evidenceState === "contradictory"
                ? "Contradictory"
                : rec.evidenceState === "stale"
                  ? "Stale"
                  : "Unsupported"}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{rec.evidenceExplanation}</p>
        <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Source</dt><dd className="font-medium">{rec.producer?.replaceAll("_", " ") ?? rec.source}</dd></div>
          <div><dt className="text-muted-foreground">Source version</dt><dd className="font-medium break-all">{rec.sourceVersion ?? "Legacy / unknown"}</dd></div>
          <div><dt className="text-muted-foreground">Created</dt><dd className="font-medium"><time dateTime={rec.createdAt}>{rec.createdAtLabel}</time></dd></div>
          <div><dt className="text-muted-foreground">Confidence</dt><dd className="font-medium">Not scored</dd></div>
        </dl>
      </div>

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
            <ListChecks className="size-3.5 text-primary" /> Observed basis
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
          {rec.evidenceLinks.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t pt-2 text-xs">
              {rec.evidenceLinks.map((link) => (
                <li key={`${link.kind}-${link.id}`}>
                  <Link className="inline-flex min-h-8 items-center gap-1 text-primary underline-offset-2 hover:underline" href={link.href}>
                    {link.label}<ExternalLink className="size-3" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!isHold && (
          <div className="rounded-lg bg-muted/55 p-3">
            <h4 className="flex items-center gap-1.5 text-xs font-medium">
              <Gauge className="size-3.5 text-primary" /> {isExternal ? "Proposed future Review direction" : "Proposed future Program effect"}
            </h4>
            <p className="mt-2 text-sm">{rec.proposedEffect}</p>
            <h5 className="mt-3 text-xs font-medium">Limitations</h5>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {rec.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
            </ul>
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

      {isExternal && !deferred && (
        <div className="mt-3 rounded-lg border p-3">
          <label className="grid gap-2 text-xs font-medium">
            Direction to accept for future Review
            <textarea
              className="min-h-24 rounded-md border bg-background p-3 text-sm font-normal leading-6"
              maxLength={1_000}
              value={externalOutcome}
              onChange={(event) => setExternalOutcome(event.target.value)}
            />
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            Accepting records this direction and your decision atomically. It does not edit or publish your Program, active workout, or completed history.
          </p>
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

      {!isHold && deferred && (
        <div className="mt-3 rounded-lg border border-amber-400/50 bg-amber-50/60 p-3 text-sm dark:bg-amber-950/20">
          <p className="font-medium">Review deferred</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {rec.revisitOn ? `Revisit on ${rec.revisitOn}.` : "No revisit date was chosen."}
            {rec.deferReason ? ` ${rec.deferReason}` : ""}
          </p>
          <Button className="mt-2 min-h-10 w-full" variant="outline" disabled={pending} onClick={() => decide("resume")}>
            Resume review
          </Button>
        </div>
      )}

      {!isHold && !deferred && (
        <details className="mt-3 rounded-lg border p-3">
          <summary className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium">
            <CalendarClock className="size-4 text-primary" /> Decide later
          </summary>
          <div className="mt-3 grid gap-3">
            <label className="grid gap-1 text-xs">
              Optional revisit date
              <input className="min-h-10 rounded-md border bg-background px-3 text-sm" type="date" value={revisitOn} onChange={(event) => setRevisitOn(event.target.value)} />
            </label>
            <label className="grid gap-1 text-xs">
              Optional note
              <textarea className="min-h-20 rounded-md border bg-background p-3 text-sm" maxLength={500} value={deferReason} onChange={(event) => setDeferReason(event.target.value)} />
            </label>
            <Button className="min-h-10 w-full" variant="outline" disabled={pending} onClick={() => decide("defer")}>
              Defer review
            </Button>
          </div>
        </details>
      )}

      <div
        className={`mt-3 grid grid-cols-1 gap-2 ${
          isHold ? "" : "min-[22rem]:grid-cols-2"
        }`}
      >
        {!isHold && !deferred && (
          <Button
            className="min-h-10 w-full"
            disabled={pending || !rec.actionable || (isExternal && externalOutcome.trim().length === 0)}
            onClick={() => decide("approve")}
          >
            {isExternal
              ? externalEdited
                ? "Accept edited direction"
                : "Accept for future Review"
              : edited
                ? "Approve edited"
                : "Approve"}
          </Button>
        )}
        {!deferred && (
          <Button
            variant="outline"
            className="min-h-10 w-full"
            disabled={pending}
            onClick={() => decide(isHold ? "dismiss" : "reject")}
          >
            {isHold ? "Dismiss notice" : "Reject"}
          </Button>
        )}
      </div>
      {!isHold && !deferred && !rec.actionable && (
        <p className="mt-2 text-xs text-muted-foreground">Approval is unavailable because this evidence is {rec.evidenceState}. Reject or defer the retained proposal instead.</p>
      )}
    </section>
  );
}
