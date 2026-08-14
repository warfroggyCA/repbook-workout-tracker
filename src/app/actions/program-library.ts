"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { switchActiveProgram } from "@/services/program-library";

const switchProgramSchema = z
  .object({
    targetProgramId: z.string().uuid(),
    expectedActiveProgramId: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();

export type SwitchProgramActionResult =
  | { ok: true }
  | { ok: false; reason: string };

export async function switchProgramAction(
  input: z.infer<typeof switchProgramSchema>,
): Promise<SwitchProgramActionResult> {
  const parsed = switchProgramSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "That Program switch is no longer valid. Refresh and try again." };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await switchActiveProgram(db, user.id, parsed.data);
  if (
    result.outcome === "switched" ||
    result.outcome === "replayed" ||
    result.outcome === "already_active"
  ) {
    revalidatePath("/program");
    revalidatePath("/program/library");
    revalidatePath("/today");
    revalidatePath("/coach");
    return { ok: true };
  }
  if (result.outcome === "active_workout") {
    return {
      ok: false,
      reason: "Finish or discard the active workout before switching Programs.",
    };
  }
  return {
    ok: false,
    reason: "The active Program changed before this switch completed. Refresh and try again.",
  };
}
