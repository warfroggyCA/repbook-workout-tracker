"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import {
  runApplicationIntegrityCheck,
  runSnapshotIntegrityCheck,
} from "@/services/recovery-health";

export async function runRecoveryChecks() {
  const user = await getCurrentUser();
  const db = await getDb();
  try {
    const [application, snapshots] = await Promise.all([
      runApplicationIntegrityCheck(db, user.id),
      runSnapshotIntegrityCheck(db, user.id),
    ]);
    revalidatePath("/recovery");
    const attentionCount = application.findings.length + snapshots.findings.length;
    return {
      ok: true as const,
      attentionCount,
      message:
        attentionCount === 0
          ? "Application and snapshot integrity checks passed."
          : `${attentionCount} item${attentionCount === 1 ? " needs" : "s need"} review.`,
    };
  } catch (error) {
    return {
      ok: false as const,
      reason:
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Recovery checks could not be completed.",
    };
  }
}
