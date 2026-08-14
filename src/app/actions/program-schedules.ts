"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import {
  adjustScheduledProgramEvent,
  completeNonResistanceScheduledEvent,
  publishProgramSchedule,
} from "@/services/program-schedules";

const publishSchema = z
  .object({
    programId: z.string().uuid(),
    sourceProgramVersionId: z.string().uuid(),
    expectedCurrentScheduleVersionId: z.string().uuid().nullable(),
    requestId: z.string().uuid(),
    document: z.unknown(),
  })
  .strict();

export async function publishProgramScheduleAction(input: z.infer<typeof publishSchema>) {
  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, reason: "Check the schedule details and try again." };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await publishProgramSchedule(db, user.id, {
    ...parsed.data,
    timezone: user.profile.timezone,
  });
  if (result.outcome === "published" || result.outcome === "replayed") {
    revalidatePath("/program");
    revalidatePath("/program/schedule");
    revalidatePath("/program/library");
    revalidatePath("/today");
    return { ok: true as const };
  }
  return {
    ok: false as const,
    reason:
      result.outcome === "invalid"
        ? "This schedule is incomplete or invalid. Check every day and try again."
        : "The Program or schedule changed first. Refresh before trying again.",
  };
}

const adjustmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skip") }).strict(),
  z.object({
    kind: z.literal("manual_reschedule"),
    toLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  }).strict(),
  z.object({ kind: z.literal("shift_rolling"), days: z.number().int().min(1).max(3650) }).strict(),
]);

const adjustSchema = z
  .object({
    eventId: z.string().uuid(),
    expectedRevision: z.number().int().min(0),
    requestId: z.string().uuid(),
    adjustment: adjustmentSchema,
  })
  .strict();

export async function adjustScheduledEventAction(input: z.infer<typeof adjustSchema>) {
  const parsed = adjustSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, reason: "That schedule change is invalid." };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await adjustScheduledProgramEvent(db, user.id, parsed.data);
  if (result.outcome === "applied" || result.outcome === "replayed") {
    revalidatePath("/today");
    revalidatePath("/program/schedule");
    return { ok: true as const };
  }
  return {
    ok: false as const,
    reason: "The schedule changed first. Refresh Today and try again.",
  };
}

const completeSchema = z
  .object({
    eventId: z.string().uuid(),
    expectedRevision: z.number().int().min(0),
    requestId: z.string().uuid(),
  })
  .strict();

export async function completeScheduledEventAction(input: z.infer<typeof completeSchema>) {
  const parsed = completeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, reason: "That schedule event is invalid." };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await completeNonResistanceScheduledEvent(db, user.id, parsed.data);
  if (result.outcome === "applied" || result.outcome === "replayed") {
    revalidatePath("/today");
    revalidatePath("/program/schedule");
    return { ok: true as const };
  }
  return {
    ok: false as const,
    reason: "The schedule changed first. Refresh Today and try again.",
  };
}
