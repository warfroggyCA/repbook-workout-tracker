import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type {
  ActiveSetExactResult,
  ActiveSetFrozenPrescription,
  ActiveSetRow,
  ActiveSetRowProjection,
  ActiveSetVersionEvidence,
} from "@/lib/active-set-row-projection";
import type { PerformedMetricType } from "@/lib/set-metric-semantics";
import { effortChoiceForLegacyRpe } from "@/lib/active-workout-language";
import {
  LIMITATION_CAUSE_LABELS,
  TECHNIQUE_ISSUE_LABELS,
} from "@/lib/set-exception-context";
import { cn } from "@/lib/utils";

type CurrentRow = Extract<ActiveSetRow, { state: "current_editable" }>;
type PlannedRow = Extract<ActiveSetRow, { state: "planned" }>;
type RetainedRow = Extract<
  ActiveSetRow,
  { state: "retained_locally" | "saving" | "retrying" | "failed" }
>;
type OutcomeRow = Extract<
  ActiveSetRow,
  { state: "skipped" | "abandoned" }
>;

export type ActiveSetLedgerDiagnosticRow = {
  key: string;
  label: string;
  summary: string;
  message: string;
  version: ActiveSetVersionEvidence | null;
};

type Props = {
  exerciseId: string;
  exerciseName: string;
  metricType: PerformedMetricType;
  rows: readonly ActiveSetRow[];
  diagnostics: ActiveSetRowProjection["diagnostics"];
  diagnosticRows?: readonly ActiveSetLedgerDiagnosticRow[];
  renderCurrentRow: (row: CurrentRow) => ReactNode;
  renderPlannedRow?: (row: PlannedRow) => ReactNode;
  renderPlannedRowDetail?: (row: PlannedRow) => ReactNode;
  renderSaveRecovery?: (row: RetainedRow) => ReactNode;
  renderOutcomeStatus?: (row: OutcomeRow) => ReactNode;
};

function formatDuration(durationSeconds: number) {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, "0")}`
    : `${seconds} sec`;
}

function formatRepetitions(reps: number) {
  return `${reps} rep${reps === 1 ? "" : "s"}`;
}

export function formatActiveSetPrescription(
  prescription: ActiveSetFrozenPrescription,
) {
  const parts: string[] = [];
  if (prescription.repsMin != null && prescription.repsMax != null) {
    parts.push(
      prescription.repsMin === prescription.repsMax
        ? formatRepetitions(prescription.repsMin)
        : `${prescription.repsMin}–${prescription.repsMax} reps`,
    );
  }
  if (prescription.load != null && prescription.loadUnit != null) {
    parts.push(`${prescription.load} ${prescription.loadUnit}`);
  } else if (prescription.loadPercent != null) {
    parts.push(`${prescription.loadPercent}%`);
  } else if (prescription.loadText?.trim()) {
    parts.push(prescription.loadText.trim());
  }
  return parts.length > 0 ? parts.join(" · ") : "No numeric target";
}

export function formatActiveSetResult(
  result: ActiveSetExactResult,
  fallbackMetricType: PerformedMetricType,
) {
  const metricType = result.metricType ?? fallbackMetricType;
  if (metricType === "duration" && result.durationSeconds != null) {
    return formatDuration(result.durationSeconds);
  }
  if (metricType === "distance_duration" && result.distanceKm != null) {
    const duration = result.durationSeconds == null
      ? ""
      : ` · ${formatDuration(result.durationSeconds)}`;
    return `${result.distanceKm} km${duration}`;
  }
  if (result.reps == null) return "No numeric result";
  const repetitions = formatRepetitions(result.reps);
  if (
    metricType === "assisted_reps" &&
    result.weight != null &&
    result.weightUnit != null
  ) {
    return `Assistance: ${result.weight} ${result.weightUnit} · ${repetitions}`;
  }
  return result.weight != null && result.weightUnit != null
    ? `${result.weight} ${result.weightUnit} × ${result.reps}`
    : repetitions;
}

function versionLabel(version: ActiveSetVersionEvidence) {
  const changeCount = `${version.count} ${version.count === 1 ? "change" : "changes"}`;
  switch (version.state) {
    case "original":
      return null;
    case "corrected":
      return `Latest: Corrected · ${changeCount}`;
    case "version_restored":
      return `Latest: Version restored · ${changeCount}`;
    case "snapshot_restored":
      return `Latest: Snapshot restored · ${changeCount}`;
  }
}

function retainedResultDetails(result: ActiveSetExactResult) {
  const details: string[] = [];
  if (result.rpe != null) {
    details.push(
      `Effort: ${effortChoiceForLegacyRpe(result.rpe)?.label ?? `RPE ${result.rpe}`}`,
    );
  }
  if (result.rir != null) details.push(`RIR ${result.rir}`);
  if (result.techniqueIssue != null) {
    details.push(`Technique: ${TECHNIQUE_ISSUE_LABELS[result.techniqueIssue]}`);
  }
  if (result.limitationCause != null) {
    details.push(`Limited by: ${LIMITATION_CAUSE_LABELS[result.limitationCause]}`);
  }
  if (result.pain != null) {
    details.push(`Pain: ${result.pain.bodyPart} ${result.pain.severity}/10`);
    if (result.pain.note?.trim()) {
      details.push(`Pain note: ${result.pain.note.trim()}`);
    }
  }
  return details;
}

function RetainedResultContext({ result }: { result: ActiveSetExactResult }) {
  const details = retainedResultDetails(result);
  if (!result.note?.trim() && details.length === 0) return null;
  return (
    <div className="mt-1 space-y-1 text-xs text-muted-foreground">
      {result.note?.trim() && <p className="break-words">{result.note.trim()}</p>}
      {details.length > 0 && (
        <p className="break-words">{details.join(" · ")}</p>
      )}
    </div>
  );
}

function membershipLabel(row: ActiveSetRow) {
  switch (row.membership) {
    case "planned":
    case "extra":
    case "legacy":
    case "unknown":
      return null;
    case "workout_only":
      return "Workout only";
    case "imported":
      return "Imported";
  }
}

function knownReason(reason: string | null) {
  if (reason == null || reason.trim() === "") return "Reason not recorded";
  const labels: Record<string, string> = {
    time_limit_reached: "Session time limit reached",
    time: "Time",
    fatigue: "Fatigue",
    pain_discomfort: "Pain or discomfort",
    equipment_unavailable_incompatible:
      "Equipment unavailable or incompatible",
    user_choice: "User choice",
    technical_app_issue: "Technical or app issue",
    technical_failure: "Technical failure",
    interruption: "Interruption",
    program_change: "Program change",
    finished_early: "Workout finished early",
  };
  return labels[reason] ?? reason;
}

function CompactRow({
  row,
  metricType,
  status,
  tone = "neutral",
  detail,
  announcement,
  children,
}: {
  row: ActiveSetRow;
  metricType: PerformedMetricType;
  status: string;
  tone?: "neutral" | "saved" | "attention";
  detail?: string | null;
  announcement?: "status" | "alert";
  children?: ReactNode;
}) {
  const result = "result" in row && row.result != null
    ? formatActiveSetResult(row.result, metricType)
    : "prescription" in row && row.prescription != null
      ? formatActiveSetPrescription(row.prescription)
      : null;
  const membership = membershipLabel(row);

  return (
    <li
      data-set-row-state={row.state}
      data-set-membership={row.membership}
      className={cn(
        "px-2.5 py-1.5 text-sm",
        tone === "attention" && "bg-[var(--surface-attention)]",
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-muted-foreground">{row.label}</span>
        <span className="min-w-0 break-words font-medium tabular-nums">
          {result}
        </span>
        <span
          role={announcement}
          aria-label={announcement ? `${row.label}: ${status}` : undefined}
          className={cn(
            "text-right text-xs font-medium",
            tone === "saved" && "text-success",
            tone === "attention" && "text-amber-900 dark:text-amber-100",
            tone === "neutral" && "text-muted-foreground",
          )}
        >
          {tone === "saved" && (
            <Check className="mr-1 inline size-3.5" aria-hidden="true" />
          )}
          {status}
        </span>
      </div>
      {(membership || detail) && (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {[membership, detail].filter(Boolean).join(" · ")}
        </p>
      )}
      {children}
    </li>
  );
}

function renderExhaustiveRow(
  row: ActiveSetRow,
  props: Pick<
    Props,
    | "exerciseName"
    | "metricType"
    | "renderCurrentRow"
    | "renderPlannedRow"
    | "renderPlannedRowDetail"
    | "renderSaveRecovery"
    | "renderOutcomeStatus"
  >,
) {
  switch (row.state) {
    case "planned": {
      const plannedContent = row.membership === "extra"
        ? props.renderPlannedRow?.(row)
        : null;
      if (plannedContent != null) {
        return (
          <li
            key={row.key}
            id={`added-set-entry-${row.sessionExerciseId}-${row.occurrenceId}`}
            data-testid="added-set-entry"
            data-set-row-state={row.state}
            data-set-membership={row.membership}
            className="bg-[var(--surface-inset)] px-2.5 py-2"
          >
            <div className="mb-1 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm">
              <p className="font-semibold">
                {row.label}
                <span className="font-normal text-muted-foreground">
                  {" "}· Added to this workout
                </span>
              </p>
              <p className="min-w-0 break-words text-muted-foreground">
                <span className="sr-only">Prescribed: </span>
                Target {formatActiveSetPrescription(row.prescription)}
              </p>
            </div>
            {row.prescription.note?.trim() && (
              <p className="mb-1 break-words text-xs text-muted-foreground">
                {row.prescription.note.trim()}
              </p>
            )}
            {plannedContent}
          </li>
        );
      }
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Planned"
        >
          {row.prescription.note?.trim() && (
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {row.prescription.note.trim()}
            </p>
          )}
          {props.renderPlannedRowDetail?.(row)}
        </CompactRow>
      );
    }
    case "current_editable": {
      const currentIsExtra = row.membership === "extra";
      return (
        <li
          key={row.key}
          data-set-row-state={row.state}
          data-set-membership={row.membership}
          className="bg-[var(--surface-selected)] px-2.5 py-2"
        >
          <section
            id={`${currentIsExtra ? "added-set-entry" : "set-entry"}-${row.sessionExerciseId}-${row.occurrenceId}`}
            data-testid={currentIsExtra ? "added-set-entry" : "current-set-entry"}
            aria-label={`${props.exerciseName}, ${row.label}`}
            className="scroll-mt-24"
          >
            <div className="mb-1 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm">
              <p className="font-semibold text-primary">
                <span className="sr-only">Current action · </span>
                {row.label}
                {currentIsExtra && (
                  <span className="font-normal text-muted-foreground">
                    {" "}· Added to this workout
                  </span>
                )}
              </p>
              <p
                data-testid="current-set-target"
                className="min-w-0 break-words text-muted-foreground"
              >
                <span className="sr-only">Prescribed: </span>
                Target {formatActiveSetPrescription(row.prescription)}
              </p>
            </div>
            {row.prescription.note?.trim() && (
              <p className="mb-1 break-words text-xs text-muted-foreground">
                {row.prescription.note.trim()}
              </p>
            )}
            {row.blockingReason && (
              <p
                role="status"
                className="mb-2 rounded-md bg-[var(--surface-attention)] px-2 py-1.5 text-xs"
              >
                {row.blockingReason}
              </p>
            )}
            <div
              data-testid="active-workout-primary"
              aria-label={`${props.exerciseName}, ${row.label}`}
            >
              {props.renderCurrentRow(row)}
            </div>
          </section>
        </li>
      );
    }
    case "retained_locally":
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Unsaved on this device"
          tone="attention"
          announcement="status"
          detail={versionLabel(row.version)}
        >
          <RetainedResultContext result={row.result} />
          {props.renderSaveRecovery?.(row)}
        </CompactRow>
      );
    case "saving":
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Saving"
          tone="attention"
          announcement="status"
          detail={versionLabel(row.version)}
        >
          <RetainedResultContext result={row.result} />
          {props.renderSaveRecovery?.(row)}
        </CompactRow>
      );
    case "retrying":
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Retrying"
          tone="attention"
          announcement="status"
          detail={versionLabel(row.version)}
        >
          <RetainedResultContext result={row.result} />
          {props.renderSaveRecovery?.(row)}
        </CompactRow>
      );
    case "failed":
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Needs attention"
          tone="attention"
          announcement="alert"
          detail={versionLabel(row.version)}
        >
          <RetainedResultContext result={row.result} />
          {props.renderSaveRecovery?.(row)}
        </CompactRow>
      );
    case "saved":
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Saved"
          tone="saved"
          detail={versionLabel(row.version)}
        />
      );
    case "skipped":
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Skipped"
          detail={[knownReason(row.reasonCode), row.note].filter(Boolean).join(" · ")}
        >
          {props.renderOutcomeStatus?.(row)}
        </CompactRow>
      );
    case "abandoned":
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Abandoned"
          detail={[knownReason(row.reasonCode), row.note].filter(Boolean).join(" · ")}
        >
          {props.renderOutcomeStatus?.(row)}
        </CompactRow>
      );
    case "completed_without_result":
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Needs review"
          tone="attention"
          announcement="alert"
          detail={row.message}
        />
      );
    case "unknown_legacy":
      return (
        <CompactRow
          key={row.key}
          row={row}
          metricType={props.metricType}
          status="Unknown"
          tone="attention"
          announcement="alert"
          detail={[row.version == null ? null : versionLabel(row.version), row.message]
            .filter(Boolean)
            .join(" · ")}
        />
      );
  }
}

export function ActiveSetLedger({
  exerciseId,
  exerciseName,
  metricType,
  rows,
  diagnostics,
  diagnosticRows = [],
  renderCurrentRow,
  renderPlannedRow,
  renderPlannedRowDetail,
  renderSaveRecovery,
  renderOutcomeStatus,
}: Props) {
  const unresolvedDiagnosticCount =
    diagnostics.unlinkedSetIds.length +
    diagnostics.duplicateSetIds.length;

  return (
    <div
      role="group"
      data-testid="active-set-ledger"
      aria-labelledby={`active-set-ledger-${exerciseId}`}
      className="overflow-hidden rounded-lg border bg-[var(--surface-primary)]"
    >
      <span
        id={`active-set-ledger-${exerciseId}`}
        className="sr-only"
      >
        {exerciseName} set ledger
      </span>
      <ol className="divide-y">
        {rows.map((row) =>
          renderExhaustiveRow(row, {
            exerciseName,
            metricType,
            renderCurrentRow,
            renderPlannedRow,
            renderPlannedRowDetail,
            renderSaveRecovery,
            renderOutcomeStatus,
          }),
        )}
        {diagnosticRows.map((row) => (
          <li
            key={row.key}
            data-set-row-state="unknown_legacy"
            data-set-membership="unknown"
            className="bg-[var(--surface-attention)] px-2.5 py-2 text-sm"
          >
            <div role="alert">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{row.label}</span>
                <span className="font-medium tabular-nums">{row.summary}</span>
                <span className="text-xs font-medium text-amber-900 dark:text-amber-100">
                  Unknown
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {[row.version == null ? null : versionLabel(row.version), row.message]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {rows.length === 0 && diagnosticRows.length === 0 && (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          No working-set occurrences are available.
        </p>
      )}
      {unresolvedDiagnosticCount > diagnosticRows.length && (
        <p
          role="alert"
          data-testid="active-set-ledger-diagnostics"
          className="border-t bg-[var(--surface-attention)] px-3 py-2 text-xs"
        >
          Some set evidence cannot be linked safely. Repbook is keeping it
          visible as needing review rather than treating it as completed.
        </p>
      )}
    </div>
  );
}
