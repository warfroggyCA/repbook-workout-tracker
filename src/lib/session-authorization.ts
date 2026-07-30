import { isAllowedEmail } from "@/lib/allowlist";

export type SessionIdentity = {
  email: string;
  name: string | null;
};

export function authorizedSessionIdentity(session: {
  user?: { email?: string | null; name?: string | null } | null;
} | null | undefined): SessionIdentity | null {
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email || !isAllowedEmail(email)) return null;
  return { email, name: session?.user?.name?.trim() || null };
}
