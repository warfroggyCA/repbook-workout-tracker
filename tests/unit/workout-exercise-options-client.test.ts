import { describe, expect, it, vi } from "vitest";
import {
  fetchWorkoutExerciseOptions,
  WorkoutExerciseOptionsRequestError,
} from "@/lib/workout-exercise-options-client";

describe("workout exercise options client", () => {
  it("passes cancellation to the independent read request", async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    );
    const controller = new AbortController();
    const request = fetchWorkoutExerciseOptions(
      "replacement",
      "00000000-0000-4000-8000-000000000001",
      controller.signal,
      fetchImplementation,
    );
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });

    controller.abort();

    await rejection;
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal).toBe(
      controller.signal,
    );
  });

  it("returns only a complete successful payload and retains safe API errors", async () => {
    const controller = new AbortController();
    const options = { currentExerciseId: "exercise-id", items: [] };
    const success = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, options }),
    );
    await expect(
      fetchWorkoutExerciseOptions(
        "alternative",
        "00000000-0000-4000-8000-000000000001",
        controller.signal,
        success,
      ),
    ).resolves.toEqual(options);

    const failure = vi.fn<typeof fetch>(async () =>
      Response.json(
        { ok: false, message: "Review the active workout." },
        { status: 409 },
      ),
    );
    await expect(
      fetchWorkoutExerciseOptions(
        "replacement",
        "00000000-0000-4000-8000-000000000001",
        controller.signal,
        failure,
      ),
    ).rejects.toEqual(
      new WorkoutExerciseOptionsRequestError(
        "Review the active workout.",
        409,
      ),
    );
  });
});
