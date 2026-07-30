import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { getTemplatesWithSlots } from "@/services/program";

describe("program template exercise identity", () => {
  it("loads and projects the exercise family used by routine icons", async () => {
    const findTemplates = vi.fn(async (options: unknown) => {
      expect(options).toMatchObject({
        with: {
          exercises: {
            with: { exercise: { with: { family: true } } },
          },
        },
      });
      return [
        {
          id: "template-1",
          exercises: [
            {
              id: "slot-1",
              exercise: {
                id: "exercise-1",
                name: "Back Squat",
                family: { name: "Squat" },
                movementPattern: "squat",
                primaryMuscles: ["quads"],
                loadType: "barbell",
              },
            },
          ],
        },
      ];
    });
    const db = {
      query: {
        workoutTemplates: { findMany: findTemplates },
        exercisePrescriptions: { findMany: vi.fn(async () => []) },
      },
    } as unknown as Db;

    const [template] = await getTemplatesWithSlots(db, "version-1");

    expect(template.slots[0].exercise).toMatchObject({
      name: "Back Squat",
      family: "Squat",
      movementPattern: "squat",
    });
  });
});
