import { memo } from "react";
import type {
  EquipmentPreparationCue,
  SessionGuidanceProjection,
} from "@/lib/session-guidance";
import { formatSessionGuidanceAction } from "@/lib/session-guidance";

function equipmentDetails(cue: EquipmentPreparationCue) {
  return [cue.equipmentLabel, cue.attachmentLabel, cue.guidance]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export const WorkoutGuidanceSummary = memo(function WorkoutGuidanceSummary({
  guidance,
  compact = false,
  deferNextActionToCurrentCard = false,
  deferCurrentActionToCockpit = false,
}: {
  guidance: SessionGuidanceProjection;
  compact?: boolean;
  deferNextActionToCurrentCard?: boolean;
  deferCurrentActionToCockpit?: boolean;
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
    const nextIsCurrentWorkingSet =
      guidance.nextAction?.kind === "working_set" &&
      guidance.nextAction.occurrenceId === guidance.current?.occurrenceId;
    const nextIsUpcomingWorkingSet =
      guidance.nextAction?.kind === "working_set" &&
      guidance.nextAction.occurrenceId === guidance.upNext?.occurrenceId &&
      !upcomingDuplicatesCurrent;
    const prepCue = nextIsCurrentWorkingSet &&
      guidance.currentEquipment.status !== "none"
      ? [currentEquipment, guidance.currentEquipment.message].filter(Boolean).join(" · ")
      : nextIsUpcomingWorkingSet
        ? [equipment, guidance.upcomingEquipment.message].filter(Boolean).join(" · ")
        : guidance.currentAction?.kind === "working_set" &&
            guidance.current && guidance.currentEquipment.status !== "none"
          ? [currentEquipment, guidance.currentEquipment.message].filter(Boolean).join(" · ")
          : null;
    const prepLabel = nextIsCurrentWorkingSet
      ? guidance.currentAction?.kind === "rest"
        ? "After rest"
        : "After warm-up"
      : nextIsUpcomingWorkingSet
        ? "Prepare"
        : "Use now";
    return (
      <section
        aria-label="Workout progress and upcoming work"
        data-ui-surface="inset"
        className="ui-surface min-w-0 px-3 py-2"
      >
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <span className="min-w-0 max-w-full font-semibold tabular-nums">
            {guidance.totals.plannedPerformed}/{guidance.totals.planned} planned
            {guidance.totals.extraPerformed > 0
              ? ` · ${guidance.totals.extraPerformed} extra`
              : ""}
            {guidance.totals.skipped > 0 ? ` · ${guidance.totals.skipped} skipped` : ""}
          </span>
          {!deferCurrentActionToCockpit && (
            <p className="min-w-0 flex-1 basis-48 break-words leading-snug max-[639px]:line-clamp-2">
              <span className="font-medium">Now:</span>{" "}
              {guidance.currentAction
                ? formatSessionGuidanceAction(guidance.currentAction)
                : guidance.completion.evidenceLimited
                  ? "Actions resolved · evidence needs review"
                  : "All actions resolved"}
            </p>
          )}
        </div>
        {guidance.nextAction && !deferNextActionToCurrentCard && (
          <p className="break-words text-xs text-muted-foreground max-[639px]:sr-only">
            <span className="font-medium text-foreground">Next:</span>{" "}
            {formatSessionGuidanceAction(guidance.nextAction)}
          </p>
        )}
        {prepCue && !deferCurrentActionToCockpit && (
          <p className="break-words text-xs text-muted-foreground max-[639px]:sr-only">
            <span className="font-medium text-foreground">{prepLabel}:</span>{" "}
            {prepCue}
          </p>
        )}
        {guidance.activeGroup && (
          <a
            href="#active-workout-group"
            onClick={(event) => {
              event.preventDefault();
              const target = document.getElementById("active-workout-group");
              const stickySummary = event.currentTarget.closest("section");
              target?.scrollIntoView({ block: "start" });
              window.requestAnimationFrame(() => {
                if (!target) return;
                const stickyBottom =
                  stickySummary?.getBoundingClientRect().bottom ?? 0;
                const targetTop = target.getBoundingClientRect().top;
                const desiredTop = stickyBottom + 8;
                const correction = targetTop - desiredTop;
                if (Math.abs(correction) > 1) {
                  window.scrollBy({ top: correction });
                }
                target.focus({ preventScroll: true });
              });
            }}
            className="mt-1 inline-flex min-h-11 items-center rounded-md px-1 text-xs font-semibold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 max-[639px]:hidden"
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
      data-ui-surface="inset"
      className="ui-surface min-w-0 space-y-2 px-3 py-2"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="ui-metadata text-primary">
          Workout progress
        </p>
        <p className="text-sm font-semibold tabular-nums">
          {guidance.totals.plannedPerformed} of {guidance.totals.planned} planned performed
        </p>
      </div>
      <p className="break-words text-xs text-muted-foreground">
        {guidance.totals.pending} remaining
        {guidance.totals.extraPerformed > 0
          ? ` · ${guidance.totals.extraPerformed} extra performed`
          : ""}
        {guidance.totals.workoutOnlyPerformed > 0
          ? ` · ${guidance.totals.workoutOnlyPerformed} workout-only performed`
          : ""}
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
      {!compact && guidance.currentAction && (
        <p className="break-words text-sm">
          <span className="font-medium">Now:</span>{" "}
          {formatSessionGuidanceAction(guidance.currentAction)}
        </p>
      )}
      {!compact && !guidance.currentAction && (
        <p className="break-words text-sm">
          <span className="font-medium">Now:</span>{" "}
          {guidance.completion.evidenceLimited
            ? "Actions resolved · evidence needs review"
            : "All actions resolved"}
        </p>
      )}
      <p className="break-words text-sm">
        <span className="font-medium">Next:</span>{" "}
        {guidance.nextAction
          ? formatSessionGuidanceAction(guidance.nextAction)
          : "No further unresolved work"}
      </p>
      {guidance.currentAction?.kind === "working_set" &&
        guidance.current && guidance.currentEquipment.status !== "none" && (
        <div className="min-w-0 rounded-md border bg-background/70 px-2.5 py-2 text-xs">
          <p className="font-medium">Use now</p>
          {currentEquipment && <p className="break-words">{currentEquipment}</p>}
          <p className="break-words text-muted-foreground">
            {guidance.currentEquipment.message}
          </p>
        </div>
      )}
      {guidance.nextAction?.kind === "working_set" &&
        (guidance.current?.occurrenceId === guidance.nextAction.occurrenceId ||
          guidance.upNext?.occurrenceId === guidance.nextAction.occurrenceId) &&
        !(
          guidance.upNext?.occurrenceId === guidance.nextAction.occurrenceId &&
          upcomingDuplicatesCurrent
        ) && (
        <div className="min-w-0 rounded-md border border-dashed bg-background/70 px-2.5 py-2 text-xs">
          <p className="font-medium">
            {guidance.currentAction?.kind === "rest" ? "After rest" : "Prepare next"}
          </p>
          {(guidance.current?.occurrenceId === guidance.nextAction.occurrenceId
            ? currentEquipment
            : equipment) && (
            <p className="break-words">
              {guidance.current?.occurrenceId === guidance.nextAction.occurrenceId
                ? currentEquipment
                : equipment}
            </p>
          )}
          <p className="break-words text-muted-foreground">
            {guidance.current?.occurrenceId === guidance.nextAction.occurrenceId
              ? guidance.currentEquipment.message
              : guidance.upcomingEquipment.message}
          </p>
        </div>
      )}
    </section>
  );
});
