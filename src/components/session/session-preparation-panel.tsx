"use client";

import type { MouseEventHandler } from "react";
import {
  CircleCheck,
  CircleHelp,
  TriangleAlert,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import type {
  SessionPreparationEquipmentProjection,
  SessionPreparationRequirementRow,
} from "@/lib/session-equipment-requirements";

const CONFIRMED_ROWS_BEFORE_DISCLOSURE = 1;

type Props = {
  projection: SessionPreparationEquipmentProjection;
  hasAcknowledgedWork: boolean;
  continueTargetId: string;
  continueLabel?: string;
  onContinue?: MouseEventHandler<HTMLAnchorElement>;
};

function RequirementStatus({
  row,
}: {
  row: SessionPreparationRequirementRow;
}) {
  if (row.status === "available") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-200">
        <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
        {row.statusText}
      </span>
    );
  }
  if (row.status === "unavailable") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
        <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
        {row.statusText}
      </span>
    );
  }
  if (row.status === "incompatible") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
        <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
        {row.statusText}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
      <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
      {row.statusText}
    </span>
  );
}

function RequirementRows({
  rows,
  label,
  compact = false,
  preview = false,
}: {
  rows: SessionPreparationRequirementRow[];
  label: string;
  compact?: boolean;
  preview?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <ul
      aria-label={label}
      className={compact
        ? "grid gap-2 min-[380px]:grid-cols-2"
        : "divide-y rounded-xl border bg-background/80"}
    >
      {rows.map((row) => (
        <li
          key={row.key}
          data-equipment-status={row.status}
          className={compact
            ? "min-h-11 min-w-0 rounded-lg border bg-background/80 px-2.5 py-2"
            : "flex min-h-11 min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1 px-3 py-2.5"}
        >
          <div className="min-w-0 flex-1 basis-40">
            <p className={preview
              ? "line-clamp-2 break-words text-sm font-medium leading-snug"
              : "break-words text-sm font-medium leading-snug"}
            >
              {row.label}
            </p>
            {row.usageContext ? (
              <p className={compact
                ? "sr-only"
                : "break-words text-xs leading-snug text-muted-foreground"}
              >
                {row.usageContext}
              </p>
            ) : null}
          </div>
          <span className={compact ? "mt-1 block" : undefined}>
            <RequirementStatus row={row} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function EvidenceNotice({
  evidenceState,
}: {
  evidenceState: SessionPreparationEquipmentProjection["evidenceState"];
}) {
  if (evidenceState === "retained") return null;
  return (
    <p
      data-testid="session-preparation-evidence-notice"
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm leading-relaxed text-amber-950 dark:text-amber-100"
    >
      {evidenceState === "updating"
        ? "Equipment details are updating after the workout changed. Previous exercise requirements are withheld."
        : evidenceState === "unknown"
          ? "This workout does not have a saved equipment list. Repbook has not guessed from exercise names; review each exercise's setup."
          : "Some exercises are missing saved equipment details. Repbook has not guessed from their names; review each exercise's setup."}
    </p>
  );
}

function projectionCountText(
  projection: SessionPreparationEquipmentProjection,
) {
  if (
    projection.evidenceState === "unknown" ||
    projection.evidenceState === "updating"
  ) {
    return null;
  }
  const count = `${projection.rows.length} ${projection.rows.length === 1 ? "item" : "items"}`;
  return projection.evidenceState === "partial_unknown"
    ? `${count} shown from saved requirements`
    : count;
}

function PreparationContents({
  projection,
  continueTargetId,
  continueLabel,
  onContinue,
  showOverview = true,
}: Omit<Props, "hasAcknowledgedWork"> & { showOverview?: boolean }) {
  const attentionRows = projection.rows.filter(
    (row) => row.classification === "attention",
  );
  const confirmedRows = projection.rows.filter(
    (row) => row.classification === "confirmed",
  );
  const visibleConfirmedRows = confirmedRows.slice(
    0,
    CONFIRMED_ROWS_BEFORE_DISCLOSURE,
  );
  const hasConfirmedDisclosure =
    confirmedRows.length > CONFIRMED_ROWS_BEFORE_DISCLOSURE;
  const countText = projectionCountText(projection);

  return (
    <div className="space-y-2.5">
      {showOverview ? (
        <div
          aria-atomic="true"
          aria-live="polite"
          className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
        >
          <p className="break-words text-sm font-medium">
            {projection.statusText}
          </p>
          {countText ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              {countText}
            </p>
          ) : null}
        </div>
      ) : null}

      <EvidenceNotice evidenceState={projection.evidenceState} />

      {attentionRows.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground">
            Needs attention
          </p>
          <RequirementRows rows={attentionRows} label="Equipment needing attention" />
        </div>
      ) : null}

      {visibleConfirmedRows.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground">
            Prepare
          </p>
          <RequirementRows
            rows={visibleConfirmedRows}
            label="Available equipment to prepare"
            compact
            preview
          />
        </div>
      ) : null}

      {hasConfirmedDisclosure ? (
        <details className="rounded-xl border bg-background/70">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none">
            <span>
              Show all {confirmedRows.length} available items
            </span>
            <span className="text-xs text-muted-foreground">Details</span>
          </summary>
          <div className="border-t p-2">
            <RequirementRows
              rows={confirmedRows}
              label="Full available equipment list"
              compact
            />
          </div>
        </details>
      ) : null}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Exact loads, machine geometry, and setup guidance stay with each exercise.
      </p>

      <a
        href={`#${encodeURIComponent(continueTargetId)}`}
        onClick={onContinue}
        className={buttonVariants({
          size: "touch",
          className: "w-full motion-reduce:transition-none",
        })}
      >
        {continueLabel}
      </a>
    </div>
  );
}

function preparationLeadText(
  projection: SessionPreparationEquipmentProjection,
  compactAvailableSummary: boolean,
) {
  if (compactAvailableSummary) {
    return projection.rows.length === 0
      ? "No equipment needed."
      : `${projection.rows.length} saved ${projection.rows.length === 1 ? "item is" : "items are"} available.`;
  }
  if (projection.evidenceState === "updating") {
    return "Wait for the updated exercise requirements before relying on this list.";
  }
  if (projection.evidenceState === "unknown") {
    return "No saved equipment list is available. Review each exercise's setup.";
  }
  if (projection.evidenceState === "partial_unknown") {
    return "Some equipment requirements are not saved. Review the attention items and each exercise's setup.";
  }
  if (projection.state === "unavailable") {
    return "Review equipment that is missing or has no compatible saved setup.";
  }
  return "Use the saved equipment list to gather what this workout needs.";
}

export function SessionPreparationPanel({
  projection,
  hasAcknowledgedWork,
  continueTargetId,
  continueLabel = "Go to warm-up",
  onContinue,
}: Props) {
  const attentionCount = projection.rows.filter(
    (row) => row.classification === "attention",
  ).length;
  const summaryStatus = attentionCount > 0
    ? `${attentionCount} ${attentionCount === 1 ? "item needs" : "items need"} attention`
    : projection.statusText;
  const needsVisibleAttention = attentionCount > 0 ||
    projection.evidenceState !== "retained";
  const compactAvailableSummary = !hasAcknowledgedWork &&
    !needsVisibleAttention &&
    projection.state === "available";

  if (hasAcknowledgedWork && !needsVisibleAttention) {
    return (
      <details
        id="session-equipment-preparation"
        data-testid="session-preparation-panel"
        className="scroll-mt-40 rounded-xl border bg-card shadow-[var(--shadow-soft)]"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none">
          <span className="min-w-0">
            <span className="block font-semibold">Workout equipment</span>
            <span className="block break-words text-xs font-normal text-muted-foreground">
              {projection.rows.length} {projection.rows.length === 1 ? "item" : "items"} · {summaryStatus}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">Show details</span>
        </summary>
        <div className="border-t px-4 py-3">
          <PreparationContents
            projection={projection}
            continueTargetId={continueTargetId}
            continueLabel={continueLabel}
            onContinue={onContinue}
          />
        </div>
      </details>
    );
  }

  return (
    <section
      id="session-equipment-preparation"
      data-testid="session-preparation-panel"
      aria-labelledby="session-equipment-preparation-heading"
      className="scroll-mt-40 rounded-xl border border-primary/25 bg-primary/5 p-3 shadow-[var(--shadow-soft)] sm:p-4"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
        {hasAcknowledgedWork ? "Equipment update" : "Before warm-up"}
      </p>
      <h2 id="session-equipment-preparation-heading" className="mt-0.5 text-lg font-semibold">
        {hasAcknowledgedWork ? "Workout equipment" : "Prepare workout"}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
        {preparationLeadText(projection, compactAvailableSummary)}
      </p>
      <div className="mt-3">
        <PreparationContents
          projection={projection}
          continueTargetId={continueTargetId}
          continueLabel={continueLabel}
          onContinue={onContinue}
          showOverview={!compactAvailableSummary}
        />
      </div>
    </section>
  );
}
