import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompilerExecutionDetails } from "@/components/session/compiler-execution-details";
import type {
  SessionCompilerInput,
  SessionCompilerOutput,
} from "@/lib/session-compiler";

const groupKey = "00000000-0000-4000-8000-000000000010";

function exercise(
  index: number,
  name: string,
  warmup: Record<string, unknown>,
  sets = 2,
) {
  return {
    slotLineageId: `00000000-0000-4000-8000-00000000002${index}`,
    templateExerciseId: `00000000-0000-4000-8000-00000000003${index}`,
    exerciseId: `00000000-0000-4000-8000-00000000004${index}`,
    exerciseName: name,
    orderIdx: index,
    supersetKey: groupKey,
    groupMemberOrderIdx: index,
    sets,
    sourceSets: sets,
    disposition: "full",
    repMin: 8,
    repMax: 10,
    targetLoad: null,
    targetLoadUnit: null,
    restSec: 90,
    notes: null,
    warmupNotes: null,
    warmupSets: [],
    setNotes: Array.from({ length: sets }, () => null),
    intent: {},
    ...warmup,
  };
}

function proposal() {
  const input = {
    day: {
      warmupItems: [{
        key: "00000000-0000-4000-8000-000000000050",
        label: "Raise temperature",
        reps: null,
        load: null,
        loadUnit: null,
        loadPercent: null,
        loadText: "Easy pace",
        notes: "Keep nasal breathing",
      }],
      supersets: [{
        key: groupKey,
        name: "Three-exercise circuit",
        structureStatus: "canonical",
        plannedRounds: 2,
        restBetweenMembersSec: 15,
        restBetweenRoundsSec: 75,
        restAfterRoundSec: 75,
      }],
    },
  } as unknown as SessionCompilerInput;
  const output = {
    status: "ready",
    exercises: [
      exercise(1, "Bench press", {
        warmupNotes: "Rehearse the pause",
        warmupSets: [{ label: "Empty bar", reps: 5, load: 45, loadUnit: "lb", loadPercent: null, loadText: null, notes: "Controlled" }],
      }),
      exercise(2, "Chest-supported row", {
        warmupSets: [{ label: "Ramp", reps: 6, load: null, loadUnit: null, loadPercent: 60, loadText: null, notes: null }],
      }),
      exercise(3, "Band pull-apart", {
        warmupSets: [{ label: "Primer", reps: 12, load: null, loadUnit: null, loadPercent: null, loadText: "Light band", notes: "Smooth tempo" }],
      }),
    ],
  } as unknown as SessionCompilerOutput;
  return { input, output };
}

describe("CompilerExecutionDetails", () => {
  it("renders every warm-up loading detail and the exact canonical round timeline", () => {
    const { input, output } = proposal();
    const html = renderToStaticMarkup(
      <CompilerExecutionDetails input={input} output={output} />,
    );
    expect(html).toContain("Raise temperature</span> · Easy pace · Keep nasal breathing");
    expect(html).toContain("Preparation note</span> · Rehearse the pause");
    expect(html).toContain("Empty bar</span> · 5 reps · 45 lb · Controlled");
    expect(html).toContain("Ramp</span> · 6 reps · 60% of working load");
    expect(html).toContain("Primer</span> · 12 reps · Light band · Smooth tempo");
    expect(html).toContain("Three-exercise circuit · 2 proposed rounds");
    expect(html).toContain("Round 1:</span> Bench press → Chest-supported row → Band pull-apart");
    expect(html).toContain("15s between members · 75s after the round");
    expect(html).toContain("Round 2:</span> Bench press → Chest-supported row → Band pull-apart");
    expect(html).toContain("15s between members · group complete");
  });

  it("renders unequal legacy rounds without inventing missing member work", () => {
    const { input, output } = proposal();
    const group = input.day.supersets[0];
    if (!("structureStatus" in group)) throw new Error("Expected a v3 group.");
    group.structureStatus = "legacy_unequal";
    group.plannedRounds = null;
    output.exercises[1].sets = 1;
    output.exercises[2].sets = 1;
    const html = renderToStaticMarkup(
      <CompilerExecutionDetails input={input} output={output} />,
    );
    expect(html).toContain("unequal legacy prescription");
    expect(html).toContain("Round 2:</span> Bench press");
    expect(html).not.toContain("Round 2:</span> Bench press → Chest-supported row");
  });
});
