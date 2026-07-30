import { cache } from "react";
import { getDb } from "@/db";
import { userProfiles } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { authorizedSessionIdentity } from "@/lib/session-authorization";
import { bootstrapUserAccount } from "@/services/account-bootstrap";

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  profile: typeof userProfiles.$inferSelect;
};

/** Session email → user row (created on first sign-in) + profile. */
export const getCurrentUser = cache(async function getCurrentUser(): Promise<CurrentUser> {
  const session = await requireSession();
  const identity = authorizedSessionIdentity(session);
  if (!identity) {
    throw new Error("The authenticated account is no longer authorized.");
  }
  const db = await getDb();
  return bootstrapUserAccount(db, identity);
});
