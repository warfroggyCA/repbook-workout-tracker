"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import {
  createDataSnapshot,
  updateDataSnapshotMetadata,
} from "@/services/snapshots";
import { restoreDataSnapshot } from "@/services/snapshot-restore";
import { runExpensiveOperation } from "@/services/expensive-operations";

const snapshotMetadataSchema = z.object({
  name: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).nullable().optional(),
  pinned: z.boolean(),
});

export async function createSnapshotNow(input: z.infer<typeof snapshotMetadataSchema>) {
  const parsed = snapshotMetadataSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const controlled = await runExpensiveOperation(
    db,
    user.id,
    "snapshot",
    () =>
      createDataSnapshot(db, user.id, {
        ...parsed,
        reason: "manual",
      })
  );
  if (!controlled.ok) {
    return { ok: false as const, reason: controlled.reason };
  }
  const result = controlled.value;
  revalidatePath("/recovery");
  return result;
}

export async function updateSnapshotMetadata(
  snapshotId: string,
  input: z.infer<typeof snapshotMetadataSchema>
) {
  const id = z.string().uuid().parse(snapshotId);
  const parsed = snapshotMetadataSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await updateDataSnapshotMetadata(db, user.id, id, parsed);
  if (result.ok) revalidatePath("/recovery");
  return result;
}

const restoreSnapshotSchema = z.object({
  snapshotId: z.string().uuid(),
  scope: z.enum(["history", "full"]),
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.string(),
});

export async function restoreSnapshot(input: z.infer<typeof restoreSnapshotSchema>) {
  const parsed = restoreSnapshotSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const controlled = await runExpensiveOperation(
    db,
    user.id,
    "snapshot",
    () => restoreDataSnapshot(db, user.id, parsed)
  );
  if (!controlled.ok) {
    return { ok: false as const, reason: controlled.reason };
  }
  const result = controlled.value;
  if (result.ok) revalidatePath("/", "layout");
  else revalidatePath("/recovery");
  return result;
}
