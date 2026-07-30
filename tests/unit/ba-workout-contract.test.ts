import { describe, expect, it } from "vitest";
import { BA_WORKOUT_EMAIL, BA_WORKOUT_FIXTURE } from "../fixtures/ba-workout-contract";

describe("BA workout fixture contract", () => {
  it("defines the isolated Toronto three-day baseline", () => {
    expect(BA_WORKOUT_EMAIL).toBe("ba.iphone.e2e@example.com");
    expect(BA_WORKOUT_FIXTURE.profile).toMatchObject({ unit: "lb", timezone: "America/Toronto" });
    expect(BA_WORKOUT_FIXTURE.program.days).toHaveLength(3);
    expect(BA_WORKOUT_FIXTURE.startingState).toMatchObject({
      completedWorkoutCount: 0,
      activeWorkoutCount: 0,
      coachMessageCount: 0,
      recommendationCount: 0,
    });
  });

  it("contains the required cautions, equipment, load semantics, and real superset", () => {
    expect(BA_WORKOUT_FIXTURE.constraints.map(({ bodyPart }) => bodyPart)).toEqual(["shoulder", "knee"]);
    expect(BA_WORKOUT_FIXTURE.equipment.bars).toContainEqual(expect.objectContaining({ barType: "ez", barWeight: 18 }));
    expect(BA_WORKOUT_FIXTURE.equipment.items.map(({ type }) => type)).toEqual(expect.arrayContaining(["barbell", "dumbbell", "bench", "rack", "bands", "cable", "machine"]));

    const [dayA, dayB, dayC] = BA_WORKOUT_FIXTURE.program.days;
    expect(dayA.exercises.filter(({ supersetKey }) => supersetKey === "day-a-pair").map(({ name }) => name)).toEqual(["Dumbbell Lateral Raise", "Pallof Press"]);
    expect(dayB.exercises.find(({ name }) => name === "Band Lat Pulldown")?.targetLoad).toBeNull();
    expect(dayC.exercises.find(({ name }) => name === "Plank")?.targetLoad).toBeNull();
    for (const day of BA_WORKOUT_FIXTURE.program.days) {
      for (const exercise of day.exercises) expect(exercise.setNotes).toHaveLength(exercise.sets);
    }
  });
});
