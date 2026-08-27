import type {
  EquipmentPreparationCue,
  GroupProgressProjection,
  SessionGuidanceProjection,
} from "@/lib/session-guidance";
import { formatRestTime } from "@/lib/rest-time";
import { cn } from "@/lib/utils";
import {
  setStartingLoadPreviewText,
  type SetStartingLoadPreview,
} from "@/lib/set-starting-load";

function progressText(totals: GroupProgressProjection["totals"]) {
  return [
    `${totals.performed} of ${totals.planned} performed`,
    totals.pending > 0 ? `${totals.pending} remaining` : null,
    totals.skipped > 0 ? `${totals.skipped} skipped` : null,
    totals.abandoned > 0 ? `${totals.abandoned} abandoned` : null,
    totals.completedWithoutResult > 0
      ? `${totals.completedWithoutResult} missing saved-result evidence`
      : null,
    totals.legacyUnknown > 0
      ? `${totals.legacyUnknown} legacy outcome unknown`
      : null,
  ].filter((value): value is string => value != null).join(" · ");
}

function equipmentStatusLabel(status: EquipmentPreparationCue["status"]) {
  const labels: Record<EquipmentPreparationCue["status"], string> = {
    none: "No setup needed",
    selected: "Reviewed setup selected",
    pending_confirmation: "Available setup awaiting confirmation",
    choice_required: "Available setups require a choice",
    unavailable: "Required setup unavailable",
    broad_only: "Exact setup unknown",
    updating: "Setup guidance updating",
  };
  return labels[status];
}

function equipmentDetails(cue: EquipmentPreparationCue) {
  return [cue.equipmentLabel, cue.attachmentLabel, cue.guidance]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export function WorkoutGroupContext({
  guidance,
  upNextLoadPreview = null,
}: {
  guidance: SessionGuidanceProjection;
  upNextLoadPreview?: SetStartingLoadPreview | null;
}) {
  const group = guidance.activeGroup;
  if (!group) return null;

  const currentRound = group.rounds.find(
    (round) => round.round === group.currentRound,
  );
  const roundLabel = group.plannedRounds != null
    ? `Round ${group.currentRound} of ${group.plannedRounds}`
    : `Recorded round ${group.currentRound}`;
  const preparationCue = group.activeRest
    ? guidance.currentEquipment
    : guidance.upcomingEquipment;
  const preparationMemberName = group.activeRest
    ? group.currentMemberName
    : group.upNextMemberName;
  const upcomingDetails = equipmentDetails(preparationCue);
  const activeRestLabel = group.activeRest?.restKind === "between_members"
    ? "Member rest"
    : group.activeRest?.restKind === "between_rounds"
      ? "Round rest"
      : group.activeRest
        ? "Rest timer"
        : null;
  const plannedRestLabel = group.restAfterCurrent.kind === "between_members"
    ? "Member rest after this set"
    : group.restAfterCurrent.kind === "between_rounds"
      ? "Round rest after this set"
      : "Rest after this set";
  const completionLabel = group.completion === "resolved"
    ? "all occurrences performed"
    : group.completion === "resolved_with_changes"
      ? "all occurrences resolved with recorded changes"
      : group.completion === "in_progress"
        ? "in progress"
        : "not started";
  const roundCompletionLabel = currentRound?.completion === "resolved"
    ? "round performed"
    : currentRound?.completion === "resolved_with_changes"
      ? "round resolved with recorded changes"
      : currentRound?.completion === "in_progress"
        ? "round in progress"
        : "round not started";

  return (
    <section
      aria-labelledby={`active-group-heading-${group.groupId}`}
      className="scroll-mt-40 rounded-xl border-2 border-violet-400/60 bg-violet-50/70 p-3 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 max-[639px]:p-2 dark:bg-violet-950/20"
      id="active-workout-group"
      data-testid="active-workout-group"
      tabIndex={0}
    >
      <details className="sm:hidden" open>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-1 py-1 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <span className="min-w-0 break-words">
            <span className="block text-xs font-bold uppercase tracking-[0.12em] text-violet-900 dark:text-violet-100">
              Superset in progress
            </span>
            {group.name} · {roundLabel} · exercise {group.currentMemberOrder} of{" "}
            {group.memberCount}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">Details</span>
        </summary>
        <div className="border-t pt-2">
          <p className="text-sm">
            <span className="font-semibold">
              {group.activeRest ? "Next member:" : "Current member:"}
            </span>{" "}
            {group.currentMemberName}
          </p>
          {group.upNextMemberName && (
            <div className="text-sm">
              <p>
                <span className="font-semibold">Up next:</span>{" "}
                {group.upNextMemberName}
              </p>
              {upNextLoadPreview && (
                <p
                  data-testid="up-next-group-load-preview"
                  className="text-xs font-medium text-violet-950 dark:text-violet-100"
                >
                  Starting load: {setStartingLoadPreviewText(upNextLoadPreview)}
                </p>
              )}
            </div>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Group progress: {progressText(group.totals)} · {completionLabel}
          </p>
          <p className="text-xs text-muted-foreground">
            {group.activeRest && activeRestLabel
              ? `${activeRestLabel}${group.activeRest.phase === "ready" ? " complete" : group.activeRest.phase === "skipped" ? " skipped" : " in progress"}.`
              : group.restAfterCurrent.seconds == null
                ? "Rest after the current set is not recorded."
                : group.restAfterCurrent.seconds > 0
                  ? `${plannedRestLabel}: ${formatRestTime(group.restAfterCurrent.seconds)}.`
                  : "No rest is planned after the current set."}
          </p>
          <ol className="mt-2 grid gap-2">
            {group.members.map((member) => {
              const isCurrent = member.order === group.currentMemberOrder;
              const isUpNext = member.order === group.upNextMemberOrder;
              return (
                <li key={`mobile-${member.sessionExerciseId}`}>
                  <a
                    href={`#exercise-${encodeURIComponent(member.sessionExerciseId)}`}
                    aria-current={isCurrent ? "step" : undefined}
                    className={cn(
                      "block min-h-11 rounded-lg border bg-background/80 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      isCurrent && "border-foreground",
                    )}
                  >
                    <span className="font-semibold">
                      {member.order}. {member.exerciseName}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {isCurrent ? "Current member · " : isUpNext ? "Up next · " : ""}
                      {progressText(member.totals)}
                    </span>
                  </a>
                </li>
              );
            })}
          </ol>
          {preparationMemberName && preparationCue.status !== "none" && (
            <div className="mt-2 rounded-lg border border-dashed bg-background/85 px-3 py-2 text-sm">
              <p className="font-semibold">Prepare for {preparationMemberName}</p>
              <p className="text-xs font-medium">
                {equipmentStatusLabel(preparationCue.status)}
              </p>
              {upcomingDetails && (
                <p className="break-words text-xs">{upcomingDetails}</p>
              )}
              <p className="break-words text-xs text-muted-foreground">
                {preparationCue.message}
              </p>
            </div>
          )}
        </div>
      </details>

      <div className="max-[639px]:hidden">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-foreground">
            Current exercise group
          </p>
          <h2
            id={`active-group-heading-${group.groupId}`}
            className="text-base font-semibold"
          >
            {group.name}
          </h2>
        </div>
        <p className="rounded-md border bg-background/80 px-2 py-1 text-xs font-semibold">
          {roundLabel}
        </p>
      </div>

      <p className="mt-2 text-sm">
        <span className="font-semibold">
          {group.activeRest ? "Next member:" : "Current member:"}
        </span>{" "}
        {group.currentMemberOrder} of {group.memberCount} ·{" "}
        {group.currentMemberName}
      </p>
      {group.upNextMemberName && (
        <div className="text-sm">
          <p>
            <span className="font-semibold">Up next in group:</span>{" "}
            {group.upNextMemberOrder} of {group.memberCount} ·{" "}
            {group.upNextMemberName}
          </p>
          {upNextLoadPreview && (
            <p
              data-testid="up-next-group-load-preview"
              className="text-xs font-medium text-violet-950 dark:text-violet-100"
            >
              Starting load: {setStartingLoadPreviewText(upNextLoadPreview)}
            </p>
          )}
        </div>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Group progress: {progressText(group.totals)} · {completionLabel}
      </p>
      {currentRound && (
        <p className="text-xs text-muted-foreground">
          {roundLabel}: {progressText(currentRound)} · {roundCompletionLabel}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {group.activeRest && activeRestLabel
          ? `${activeRestLabel}${group.activeRest.phase === "ready" ? " complete" : group.activeRest.phase === "skipped" ? " skipped" : " in progress"}.`
          : group.restAfterCurrent.seconds == null
            ? "Rest after the current set is not recorded."
            : group.restAfterCurrent.seconds > 0
              ? `${plannedRestLabel}: ${formatRestTime(group.restAfterCurrent.seconds)}.`
              : "No rest is planned after the current set."}
      </p>
      {group.hasLaterResolvedWork && (
        <p className="mt-1 rounded-md border border-amber-500/40 bg-amber-50/80 px-2 py-1.5 text-xs text-amber-950 dark:bg-amber-950/25 dark:text-amber-100">
          Later group work is already recorded. This remains the next pending
          member in the saved workout order.
        </p>
      )}

      <ol className="mt-3 grid gap-2 sm:grid-cols-2">
        {group.members.map((member) => {
          const isCurrent = member.order === group.currentMemberOrder;
          const isUpNext = member.order === group.upNextMemberOrder;
          return (
            <li key={member.sessionExerciseId}>
              <a
                href={`#exercise-${encodeURIComponent(member.sessionExerciseId)}`}
                aria-current={isCurrent ? "step" : undefined}
                tabIndex={0}
                className={cn(
                  "block min-h-11 rounded-lg border bg-background/80 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  isCurrent && "border-foreground",
                )}
              >
                <span className="font-semibold">
                  {member.order}. {member.exerciseName}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {isCurrent ? "Current member · " : isUpNext ? "Up next · " : ""}
                  {progressText(member.totals)}
                </span>
                {member.substituted && (
                  <span className="block text-xs text-muted-foreground">
                    Workout replacement for {member.plannedExerciseName}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ol>

      {preparationMemberName && preparationCue.status !== "none" && (
        <div className="mt-3 rounded-lg border border-dashed bg-background/85 px-3 py-2 text-sm">
          <p className="font-semibold">
            Prepare for {preparationMemberName}
          </p>
          <p className="text-xs font-medium">
            {equipmentStatusLabel(preparationCue.status)}
          </p>
          {upcomingDetails && (
            <p className="break-words text-xs">{upcomingDetails}</p>
          )}
          <p className="break-words text-xs text-muted-foreground">
            {preparationCue.message}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Preparation is guidance only. It does not select equipment or
            change the current set.
          </p>
        </div>
      )}
      </div>
    </section>
  );
}
