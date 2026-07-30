import { auth } from "@/lib/auth";
import { getDb } from "@/db";
import { authorizedSessionIdentity } from "@/lib/session-authorization";
import { bootstrapUserAccount } from "@/services/account-bootstrap";

/** Route-handler auth: returns the user or null (caller responds 401). */
export async function getRouteUser() {
  const session = await auth();
  const identity = authorizedSessionIdentity(session);
  if (!identity) return null;
  const db = await getDb();
  return bootstrapUserAccount(db, identity);
}
