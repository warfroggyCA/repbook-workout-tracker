import { memo } from "react";
import type {
  EquipmentPreparationCue,
  SessionGuidanceAction,
  SessionGuidanceProjection,
} from "@/lib/session-guidance";
import { cn } from "@/lib/utils";

export function formatGuidanceActionLabel(action: SessionGuidanceAction) {
  const setLabel = action.position.lowercaseLabel;
  if (!action.group) return `${action.actualExerciseName}, ${setLabel}`;
  return `${action.group.name}, round ${action.group.round}, member ${action.group.member} of ${action.group.memberCount}: ${action.actualExerciseName}, ${setLabel}`;
}

function equipmentDetails(cue: EquipmentPreparationCue) {
  return [cue.equipmentLabel, cue.attachmentLabel, cue.guidance]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export const WorkoutGuidanceSummary = memo(function WorkoutGuidanceSummary({
  guidance,
  compact = false,
}: {
  guidance: SessionGuidanceProjection;
  compact?: boolean;
}) {
  const currentEquipment = equipmentDetails(guidance.currentEquipment);
  const equipment = equipmentDetails(guidance.upcomingEquipment);
  const upcomingDuplicatesCurrent =
    guidance.current?.sessionExerciseId === guidance.upNext?.sessionExerciseId &&
    guidance.currentEquipment.status !== "none" &&
    guidance.currentEquipment.status === guidance.upcomingEquipment.status &&
    guidance.currentEquipment.equipmentLabel ===
      guidance.upcomingEquipment.equipmentLabel &&
    guidance.currentEquipment.attachmentLabel ===
      guidance.upcomingEquipment.attachmentLabel &&
    guidance.currentEquipment.guidance === guidance.upcomingEquipment.guidance &&
    guidance.currentEquipment.message === guidance.upcomingEquipment.message;

  if (compact) {
    const prepCue = guidance.upNext && !upcomingDuplicatesCurrent
      ? [equipment, guidance.upcomingEquipment.message].filter(Boolean).join(" · ")
      : guidance.current && guidance.currentEquipment.status !== "none"
        ? [currentEquipment, guidance.currentEquipment.message].filter(Boolean).join(" · ")
        : null;
    return (
      <section
        aria-label="Workout progress and upcoming work"
        className="min-w-0 rounded-lg border bg-background/95 px-3 py-2 shadow-sm"
      >
        <div className="flex min-w-0 items-baseline gap-2 text-sm">
          <span className="shrink-0 font-semibold tabular-nums">
            {guidance.totals.performed}/{guidance.totals.planned}
            {guidance.totals.skipped > 0 ? ` · ${guidance.totals.skipped} skipped` : ""}
          </span>
          <p className="min-w-0 break-words leading-snug">
            <span className="font-medium">Next:</span>{" "}
            {guidance.upNext
              ? formatGuidanceActionLabel(guidance.upNext)
              : "No further planned set"}
          </p>
        </div>
        {prepCue && (
          <p className="break-words text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Prepare:</span> {prepCue}
          </p>
        )}
        {guidance.activeGroup && (
          <a
            href="#active-workout-group"
            onClick={(event) => {
              event.preventDefault();
              const target = document.getElementById("active-workout-group");
              const stickySummary = event.currentTarget
                .closest("section")
                ?.parentElement;
              target?.scrollIntoView({ block: "start" });
              window.requestAnimationFrame(() => {
                if (!target) return;
                const stickyBottom =
                  stickySummary?.getBoundingClientRect().bottom ?? 0;
                const targetTop = target.getBoundingClientRect().top;
                const desiredTop = stickyBottom + 8;
                if (targetTop < desiredTop) {
                  window.scrollBy({ top: targetTop - desiredTop });
                }
                target.focus({ preventScroll: true });
              });
            }}
            className="mt-1 inline-flex min-h-11 items-center rounded-md px-1 text-xs font-semibold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {`View ${guidance.activeGroup.name} group & prep`}
          </a>
        )}
      </section>
    );
  }

  return (
    <section
      aria-label="Workout progress and upcoming work"
      className={cn(
        "min-w-0 rounded-lg border bg-muted/35 px-3 py-2",
        compact ? "space-y-1" : "space-y-2",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">
          Workout progress
        </p>
        <p className="text-sm font-semibold tabular-nums">
          {guidance.totals.performed} of {guidance.totals.planned} performed
        </p>
      </div>
      <p className="break-words text-xs text-muted-foreground">
        {guidance.totals.pending} remaining
        {guidance.totals.skipped > 0
          ? ` · ${guidance.totals.skipped} skipped`
          : ""}
        {guidance.totals.completedWithoutResult > 0
          ? ` · ${guidance.totals.completedWithoutResult} awaiting saved-result evidence`
          : ""}
        {guidance.totals.abandoned > 0
          ? ` · ${guidance.totals.abandoned} abandoned`
          : ""}
        {guidance.totals.legacyUnknown > 0
          ? ` · ${guidance.totals.legacyUnknown} legacy outcome unknown`
          : ""}
      </p>
      {!compact && guidance.current && (
        <p className="break-words text-sm">
          <span className="font-medium">Current:</span> {formatGuidanceActionLabel(guidance.current)}
        </p>
      )}
      <p className="break-words text-sm">
        <span className="font-medium">Up next:</span>{" "}
        {guidance.upNext ? formatGuidanceActionLabel(guidance.upNext) : "No further planned set"}
      </p>
      {guidance.current && guidance.currentEquipment.status !== "none" && (
        <div className="min-w-0 rounded-md border bg-background/70 px-2.5 py-2 text-xs">
          <p className="font-medium">Use now</p>
          {currentEquipment && <p className="break-words">{currentEquipment}</p>}
          <p className="break-words text-muted-foreground">
            {guidance.currentEquipment.message}
          </p>
        </div>
      )}
      {guidance.upNext && !upcomingDuplicatesCurrent && (
        <div className="min-w-0 rounded-md border border-dashed bg-background/70 px-2.5 py-2 text-xs">
          <p className="font-medium">Prepare next</p>
          {equipment && <p className="break-words">{equipment}</p>}
          <p className="break-words text-muted-foreground">
            {guidance.upcomingEquipment.message}
          </p>
        </div>
      )}
    </section>
  );
});
