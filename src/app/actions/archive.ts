"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { restoreArchiveOperation as restoreOperation } from "@/services/archive";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";

export async function restoreArchiveOperation(operationId: string) {
  const id = z.string().uuid().parse(operationId);
  const user = await getCurrentUser();
  const db = await getDb();
  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_restore",
    `Automatic protection created before restoring archive operation ${id}.`
  );
  if (!safety.ok) {
    return {
      ok: false as const,
      reason: `Nothing was restored because the safety snapshot could not be verified: ${safety.reason}`,
    };
  }
  const result = await restoreOperation(db, user.id, id);
  if (result.ok) {
    revalidatePath("/archive");
    revalidatePath("/history");
    revalidatePath("/today");
    revalidatePath("/coach");
    revalidatePath("/program");
    revalidatePath("/export");
    revalidatePath("/recovery");
  }
  return result;
}
