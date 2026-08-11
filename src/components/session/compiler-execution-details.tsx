import type {
  SessionCompilerInput,
  SessionCompilerOutput,
} from "@/lib/session-compiler";

type WarmupStep = {
  beforeSlotLineageId?: string | null;
  label: string;
  reps: number | null;
  load: number | null;
  loadUnit: "lb" | "kg" | null;
  loadPercent: number | null;
  loadText: string | null;
  notes: string | null;
};

function warmupDetails(step: WarmupStep) {
  return [
    step.reps != null ? `${step.reps} reps` : null,
    step.load != null && step.loadUnit ? `${step.load} ${step.loadUnit}` : null,
    step.loadPercent != null ? `${step.loadPercent}% of working load` : null,
    step.loadText,
    step.notes,
  ].filter((detail): detail is string => Boolean(detail));
}

function WarmupStepLine({ step }: { step: WarmupStep }) {
  const details = warmupDetails(step);
  return (
    <li>
      <span className="font-medium text-foreground">{step.label}</span>
      {details.length > 0 ? ` · ${details.join(" · ")}` : ""}
    </li>
  );
}

export function CompilerExecutionDetails({
  input,
  output,
}: {
  input: SessionCompilerInput;
  output: SessionCompilerOutput;
}) {
  if (output.status !== "ready") return null;
  const dayWarmups = "warmupItems" in input.day ? input.day.warmupItems : [];
  const exerciseNameByLineage = new Map(
    output.exercises.map((exercise) => [
      exercise.slotLineageId,
      exercise.exerciseName,
    ]),
  );
  const exerciseWarmups = output.exercises.filter(
    (exercise) => Boolean(exercise.warmupNotes?.trim()) || exercise.warmupSets.length > 0,
  );
  const groups = input.day.supersets.flatMap((group) =>
    "structureStatus" in group
      ? [{
          key: group.key,
          name: group.name,
          structureStatus: group.structureStatus,
          restBetweenMembersSec: group.restBetweenMembersSec,
          restBetweenRoundsSec: group.restBetweenRoundsSec,
        }]
      : [],
  );

  return (
    <div className="mt-4 space-y-3">
      {dayWarmups.length > 0 && (
        <section className="rounded-xl border p-3" aria-labelledby="compiler-day-warmup-heading">
          <h3 id="compiler-day-warmup-heading" className="text-sm font-medium">Warm-up timeline</h3>
          <ol className="mt-2 space-y-1 text-sm text-muted-foreground">
            {dayWarmups.map((item) => (
              <li key={item.key}>
                <span className="font-medium text-foreground">
                  {item.beforeSlotLineageId
                    ? `Before ${exerciseNameByLineage.get(item.beforeSlotLineageId) ?? "exercise"}`
                    : "At workout start"}
                </span>
                <ul className="ml-4 list-disc">
                  <WarmupStepLine step={item} />
                </ul>
              </li>
            ))}
          </ol>
        </section>
      )}

      {exerciseWarmups.length > 0 && (
        <section className="rounded-xl border p-3" aria-labelledby="compiler-exercise-warmup-heading">
          <h3 id="compiler-exercise-warmup-heading" className="text-sm font-medium">Exercise warm-ups</h3>
          <div className="mt-2 space-y-3">
            {exerciseWarmups.map((exercise) => (
              <div key={exercise.slotLineageId}>
                <h4 className="text-sm font-medium">{exercise.exerciseName}</h4>
                <ol className="mt-1 space-y-1 text-sm text-muted-foreground">
                  {exercise.warmupNotes?.trim() && (
                    <li><span className="font-medium text-foreground">Preparation note</span> · {exercise.warmupNotes}</li>
                  )}
                  {exercise.warmupSets.map((step, index) => (
                    <WarmupStepLine key={`${exercise.slotLineageId}:${index}`} step={step} />
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </section>
      )}

      {groups.length > 0 && (
        <section className="rounded-xl border p-3" aria-labelledby="compiler-group-timeline-heading">
          <h3 id="compiler-group-timeline-heading" className="text-sm font-medium">Round-by-round execution</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">This is the exact grouped order the accepted workout will follow.</p>
          <div className="mt-3 space-y-4">
            {groups.map((group) => {
              const members = output.exercises
                .filter((exercise) => exercise.supersetKey === group.key)
                .sort((left, right) =>
                  (left.groupMemberOrderIdx ?? left.orderIdx) -
                  (right.groupMemberOrderIdx ?? right.orderIdx)
                );
              const rounds = Math.max(0, ...members.map((member) => member.sets));
              return (
                <div key={group.key}>
                  <h4 className="text-sm font-medium">
                    {group.name} · {group.structureStatus === "canonical" ? `${rounds} proposed rounds` : "unequal legacy prescription"}
                  </h4>
                  <ol className="mt-2 space-y-2">
                    {Array.from({ length: rounds }, (_, roundIndex) => {
                      const round = roundIndex + 1;
                      const activeMembers = members.filter((member) => member.sets >= round);
                      const afterRound = round < rounds
                        ? `${group.restBetweenRoundsSec}s after the round`
                        : "group complete";
                      return (
                        <li key={`${group.key}:${round}`} className="rounded-lg bg-muted/50 p-2 text-sm">
                          <p><span className="font-medium">Round {round}:</span> {activeMembers.map((member) => member.exerciseName).join(" → ")}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{group.restBetweenMembersSec}s between members · {afterRound}</p>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
