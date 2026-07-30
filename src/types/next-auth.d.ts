import "next-auth";
import "@auth/core/jwt";

declare module "next-auth" {
  interface Session {
    lastProviderSignInAt: number | null;
    lastAuthProvider: string | null;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    lastProviderSignInAt?: number;
    lastAuthProvider?: string;
  }
}
