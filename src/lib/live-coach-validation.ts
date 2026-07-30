import { z } from "zod";

export const startLiveCoachTurnSchema = z.object({
  sessionId: z.string().uuid(),
  sessionExerciseId: z.string().uuid().nullable().optional(),
  completedSetId: z.string().uuid().nullable().optional(),
  messageKind: z.enum(["question", "observation"]),
  // Realtime voice remains reserved. Typed messages and user-reviewed
  // dictation share this same save-first endpoint and durable identity.
  inputMode: z.enum(["text", "dictation"]),
  content: z
    .string()
    .trim()
    .min(2, "Add a little more detail for Coach.")
    .max(800, "Keep the message under 800 characters."),
  clientKey: z.string().uuid(),
});

export function liveCoachValidationIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Live Coach received an invalid message.";
}
