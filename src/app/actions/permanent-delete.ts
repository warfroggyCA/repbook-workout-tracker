"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import {
  isAllowedEmail,
  isGitHubAuthConfigured,
  signIn,
} from "@/lib/auth";
import { getCurrentUser } from "@/lib/user";
import {
  PERMANENT_DELETE_COOKIE,
  permanentDeleteCookieOptions,
} from "@/lib/permanent-delete-cookie";
import {
  createPermanentDeleteGrant,
  getPermanentDeletePreview,
  getValidPermanentDeleteGrant,
  permanentlyDeleteArchiveOperation as deleteArchiveOperation,
  PERMANENT_DELETE_CONFIRMATION,
} from "@/services/permanent-delete";
import { createDataSnapshot, defaultSnapshotName } from "@/services/snapshots";

const operationIdSchema = z.string().uuid();

async function storeGrantCookie(token: string, expiresAt: Date) {
  (await cookies()).set(
    PERMANENT_DELETE_COOKIE,
    token,
    permanentDeleteCookieOptions(expiresAt)
  );
}

export async function beginPermanentDeleteReauthentication(operationId: string) {
  const id = operationIdSchema.parse(operationId);
  if (!isGitHubAuthConfigured()) {
    return { ok: false as const, reason: "GitHub identity verification is unavailable." };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  const grant = await createPermanentDeleteGrant(db, user.id, id, "github");
  if (!grant.ok) return grant;
  await storeGrantCookie(grant.token, grant.expiresAt);
  await signIn(
    "github",
    { redirectTo: `/archive/${id}/delete/reauth` },
    { prompt: "select_account", allow_signup: "false" }
  );
  return { ok: true as const };
}

export async function completeDevPermanentDeleteReauthentication(
  operationId: string,
  email: string
) {
  const id = operationIdSchema.parse(operationId);
  if (process.env.NODE_ENV !== "development") {
    return { ok: false as const, reason: "Development identity verification is disabled." };
  }
  const user = await getCurrentUser();
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail !== user.email.toLowerCase() || !isAllowedEmail(normalizedEmail)) {
    return { ok: false as const, reason: "The email did not match the signed-in owner." };
  }
  const db = await getDb();
  const now = new Date();
  const grant = await createPermanentDeleteGrant(
    db,
    user.id,
    id,
    "dev-login",
    now,
    now
  );
  if (!grant.ok) return grant;
  await storeGrantCookie(grant.token, grant.expiresAt);
  revalidatePath(`/archive/${id}/delete`);
  return { ok: true as const };
}

export async function permanentlyDeleteArchiveOperation(input: {
  operationId: string;
  confirmation: string;
  acknowledged: boolean;
}) {
  const parsed = z
    .object({
      operationId: z.string().uuid(),
      confirmation: z.literal(PERMANENT_DELETE_CONFIRMATION),
      acknowledged: z.literal(true),
    })
    .safeParse(input);
  if (!parsed.success) {
    return {
      ok: false as const,
      reason: `Type ${PERMANENT_DELETE_CONFIRMATION} exactly.`,
    };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  const token = (await cookies()).get(PERMANENT_DELETE_COOKIE)?.value;
  if (!token) {
    return { ok: false as const, reason: "Verify your identity again before deleting." };
  }
  const grant = await getValidPermanentDeleteGrant(
    db,
    user.id,
    parsed.data.operationId,
    token
  );
  if (!grant) {
    return { ok: false as const, reason: "Verify your identity again before deleting." };
  }
  const preview = await getPermanentDeletePreview(db, user.id, parsed.data.operationId);
  if (!preview || preview.blockers.length > 0) {
    return { ok: false as const, reason: "Review the updated permanent-delete preview first." };
  }
  const now = new Date();
  const safety = await createDataSnapshot(db, user.id, {
    name: `${defaultSnapshotName(now)} · before permanent deletion`,
    note: `Automatic protection created before permanently deleting Archive action ${parsed.data.operationId}.`,
    reason: "pre_permanent_delete",
    sourceOperationId: parsed.data.operationId,
    pinned: false,
  }, { now });
  if (!safety.ok) {
    return {
      ok: false as const,
      reason: `Nothing was deleted because the safety snapshot could not be verified: ${safety.reason}`,
    };
  }
  const result = await deleteArchiveOperation(
    db,
    user.id,
    parsed.data.operationId,
    token,
    parsed.data.confirmation,
    safety.snapshotId
  );
  if (!result.ok) return result;
  (await cookies()).set(PERMANENT_DELETE_COOKIE, "", {
    ...permanentDeleteCookieOptions(new Date(0)),
    maxAge: 0,
  });
  for (const path of [
    "/archive",
    "/history",
    "/today",
    "/coach",
    "/program",
    "/export",
    "/recovery",
  ]) {
    revalidatePath(path);
  }
  return { ok: true as const, preview: result.preview };
}
