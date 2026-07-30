import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireSession } from "@/lib/auth";
import { getCurrentUser } from "@/lib/user";
import { PERMANENT_DELETE_COOKIE } from "@/lib/permanent-delete-cookie";
import { authenticatePermanentDeleteGrant } from "@/services/permanent-delete";

export default async function PermanentDeleteReauthPage({
  params,
}: {
  params: Promise<{ operationId: string }>;
}) {
  const { operationId } = await params;
  const session = await requireSession();
  const user = await getCurrentUser();
  const token = (await cookies()).get(PERMANENT_DELETE_COOKIE)?.value;
  const authenticatedAt = session.lastProviderSignInAt
    ? new Date(session.lastProviderSignInAt)
    : null;
  if (
    !token ||
    session.lastAuthProvider !== "github" ||
    !authenticatedAt ||
    Number.isNaN(authenticatedAt.getTime())
  ) {
    redirect(`/archive/${operationId}/delete?reauth=failed`);
  }
  const db = await getDb();
  const result = await authenticatePermanentDeleteGrant(
    db,
    user.id,
    token,
    "github",
    authenticatedAt
  );
  if (!result.ok || result.operationId !== operationId) {
    redirect(`/archive/${operationId}/delete?reauth=failed`);
  }
  redirect(`/archive/${operationId}/delete?reauth=verified`);
}
