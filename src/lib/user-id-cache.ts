import { getDb } from "@/db";
import { auth } from "@/lib/auth";
import { authorizedSessionIdentity } from "@/lib/session-authorization";
import { bootstrapUserAccount } from "@/services/account-bootstrap";

const MAX_CACHED_USER_IDS = 16;
const userIdByEmail = new Map<string, string>();

function rememberUserId(email: string, userId: string) {
  userIdByEmail.delete(email);
  userIdByEmail.set(email, userId);
  while (userIdByEmail.size > MAX_CACHED_USER_IDS) {
    const oldest = userIdByEmail.keys().next().value;
    if (oldest === undefined) break;
    userIdByEmail.delete(oldest);
  }
}

async function authorizedIdentity() {
  const identity = authorizedSessionIdentity(await auth());
  if (!identity) {
    throw new Error("The authenticated account is no longer authorized.");
  }
  return identity;
}

/** Auth and allowlist are checked on every call; only the bootstrap read is cached. */
export async function getCurrentUserIdFast(): Promise<string> {
  const identity = await authorizedIdentity();
  const cached = userIdByEmail.get(identity.email);
  if (cached) {
    rememberUserId(identity.email, cached);
    return cached;
  }
  const user = await bootstrapUserAccount(await getDb(), identity);
  rememberUserId(identity.email, user.id);
  return user.id;
}

/** Evict one observed id and perform one full, authorized bootstrap resolution. */
export async function refreshCurrentUserIdFast(
  staleUserId: string
): Promise<string> {
  const identity = await authorizedIdentity();
  if (userIdByEmail.get(identity.email) === staleUserId) {
    userIdByEmail.delete(identity.email);
  }
  const user = await bootstrapUserAccount(await getDb(), identity);
  rememberUserId(identity.email, user.id);
  return user.id;
}

export function resetUserIdCacheForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The user id cache can only be reset by tests.");
  }
  userIdByEmail.clear();
}
