import NextAuth, { type NextAuthConfig, type Session } from "next-auth";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import { redirect } from "next/navigation";
import { optionalEnv } from "@/lib/env";
import { isAllowedEmail } from "@/lib/allowlist";
import { authorizedSessionIdentity } from "@/lib/session-authorization";
import {
  disposablePreviewIdentityEmail,
  isDisposableAcceptanceRuntime,
  isDisposableVercelPreviewRuntime,
} from "@/lib/acceptance-runtime";

export { isAllowedEmail } from "@/lib/allowlist";

export function isGitHubAuthConfigured(): boolean {
  return !!optionalEnv("AUTH_GITHUB_ID") && !!optionalEnv("AUTH_GITHUB_SECRET");
}

export function isDevLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" ||
    isDisposableAcceptanceRuntime() ||
    isDisposableVercelPreviewRuntime()
  );
}

export function isPreviewLoginEnabled(): boolean {
  return isDisposableVercelPreviewRuntime();
}

const providers: NextAuthConfig["providers"] = [];

if (isGitHubAuthConfigured()) {
  providers.push(GitHub);
}

// Passwordless local/E2E login, or one-click disposable Preview login.
if (isDevLoginEnabled()) {
  const previewLogin = isPreviewLoginEnabled();
  providers.push(
    Credentials({
      id: "dev-login",
      name: previewLogin ? "Preview login" : "Dev login",
      credentials: previewLogin
        ? {}
        : { email: { label: "Email", type: "email" } },
      authorize: async (credentials) => {
        if (previewLogin) {
          const email = disposablePreviewIdentityEmail();
          return email
            ? {
                email,
                name: "Preview user",
              }
            : null;
        }
        const email = String(credentials?.email ?? "").trim().toLowerCase();
        return isAllowedEmail(email)
          ? { email, name: previewLogin ? "Preview user" : "Dev user" }
          : null;
      },
    })
  );
}

export const authConfig = {
  providers,
  secret:
    optionalEnv("AUTH_SECRET") ??
    (process.env.NODE_ENV === "development" ? "insecure-dev-secret" : undefined),
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  callbacks: {
    signIn: ({ user }) => isAllowedEmail(user.email),
    jwt: ({ token, account }) => {
      if (account?.provider) {
        token.lastProviderSignInAt = Date.now();
        token.lastAuthProvider = account.provider;
      }
      return token;
    },
    session: ({ session, token }) => {
      session.lastProviderSignInAt =
        typeof token.lastProviderSignInAt === "number"
          ? token.lastProviderSignInAt
          : null;
      session.lastAuthProvider =
        typeof token.lastAuthProvider === "string"
          ? token.lastAuthProvider
          : null;
      return session;
    },
  },
  pages: { signIn: "/sign-in" },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/** Server-side guard for pages and actions; redirects when unauthenticated. */
export async function requireSession(): Promise<Session> {
  const session = await auth();
  if (!session || !authorizedSessionIdentity(session)) redirect("/sign-in");
  return session;
}
