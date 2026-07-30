"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { acceptSessionCompilerProposal, createSessionCompilerProposal, discardSessionCompilerProposal } from "@/services/session-compiler";
import { isValidIanaTimezone } from "@/lib/workout-calendar";

const proposalFormSchema = z.object({
  dayLineageId: z.string().uuid(),
  requestedMinutes: z.coerce.number().int().min(5).max(600),
  energy: z.enum(["low", "usual", "good"]),
  clientMutationId: z.string().uuid(),
  confirmedConstraintSlotLineageIds: z.array(z.string().uuid()).max(50),
  busyEquipmentSlotLineageIds: z.array(z.string().uuid()).max(50),
});

export async function createCompilerProposal(formData: FormData) {
  const parsed = proposalFormSchema.parse({
    dayLineageId: formData.get("dayLineageId"),
    requestedMinutes: formData.get("requestedMinutes"),
    energy: formData.get("energy"),
    clientMutationId: formData.get("clientMutationId"),
    confirmedConstraintSlotLineageIds: formData.getAll("constraintSlot"),
    busyEquipmentSlotLineageIds: formData.getAll("busySlot"),
  });
  const user = await getCurrentUser();
  const proposal = await createSessionCompilerProposal(await getDb(), user.id, parsed);
  redirect(`/program/compile/${proposal.id}`);
}

export async function acceptCompilerProposal(proposalId: string, acceptanceKey: string, formData: FormData) {
  z.literal("reviewed").parse(formData.get("reviewConfirmation"));
  const timezoneValue = z.string().parse(formData.get("timezone"));
  if (!isValidIanaTimezone(timezoneValue)) throw new Error("A valid timezone is required.");
  const user = await getCurrentUser();
  const result = await acceptSessionCompilerProposal(
    await getDb(),
    user.id,
    z.string().uuid().parse(proposalId),
    z.string().uuid().parse(acceptanceKey),
    timezoneValue,
  );
  if (result.outcome === "accepted" || result.outcome === "already_accepted") {
    redirect(`/session/${result.sessionId}`);
  }
  if (result.outcome === "active_workout_exists") redirect("/today?compiler=active");
  redirect(`/program/compile/${proposalId}?status=${result.outcome}`);
}

export async function discardCompilerProposal(proposalId: string) {
  const user = await getCurrentUser();
  await discardSessionCompilerProposal(await getDb(), user.id, z.string().uuid().parse(proposalId));
  redirect("/program");
}
