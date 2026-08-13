import { z } from "zod";
import { getDb } from "@/db";
import { sensitiveJson } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { getExerciseAlternativeOptions } from "@/services/exercise-alternatives";
import { getExerciseReplacementOptions } from "@/services/exercise-replacements";
import { WorkoutExerciseOptionsUnavailableError } from "@/services/workout-exercise-options-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  mode: z.enum(["alternative", "replacement"]),
  sessionExerciseId: z.string().uuid(),
});

export async function GET(request: Request) {
  const user = await getRouteUser();
  if (!user) {
    return sensitiveJson(
      { ok: false, message: "Sign in again to review workout exercises." },
      { status: 401 },
    );
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    mode: url.searchParams.get("mode"),
    sessionExerciseId: url.searchParams.get("sessionExerciseId"),
  });
  if (!parsed.success) {
    return sensitiveJson(
      { ok: false, message: "That exercise-catalog request was not valid." },
      { status: 400 },
    );
  }

  try {
    const db = await getDb();
    const options = parsed.data.mode === "alternative"
      ? await getExerciseAlternativeOptions(
          db,
          user.id,
          parsed.data.sessionExerciseId,
        )
      : await getExerciseReplacementOptions(
          db,
          user.id,
          parsed.data.sessionExerciseId,
        );
    return sensitiveJson({ ok: true, options });
  } catch (error) {
    if (error instanceof WorkoutExerciseOptionsUnavailableError) {
      return sensitiveJson(
        {
          ok: false,
          message:
            error.code === "workout_not_active"
              ? "Only an active workout can be changed."
              : "The planned exercise is no longer available for this workout.",
        },
        { status: 409 },
      );
    }
    return sensitiveJson(
      {
        ok: false,
        message:
          "The exercise catalog could not be loaded. Try again or return to the workout.",
      },
      { status: 503 },
    );
  }
}
