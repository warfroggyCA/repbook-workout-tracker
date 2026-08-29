import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("WorkoutStartForm pending contract", () => {
  it("uses the native form pending state without replacing the replay identity", () => {
    const source = readFileSync(
      "src/components/session/workout-start-form.tsx",
      "utf8",
    );

    expect(source).toContain("const { pending } = useFormStatus();");
    expect(source).toContain("disabled={pending}");
    expect(source).toContain("aria-busy={pending}");
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain(
      "Repbook will open the workout after its start is",
    );
    expect(source).toContain(
      "markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.workoutStartSubmit)",
    );
    expect(source).toContain(
      "markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.workoutStartPending)",
    );
    expect(source).toContain("value={effectiveStartRequestKey}");
    expect(source).toContain("action={formAction}");
    expect(source).not.toContain("event.preventDefault()");
  });
});
