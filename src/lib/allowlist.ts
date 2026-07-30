import { optionalEnv } from "@/lib/env";

export function allowedEmailSet(value = optionalEnv("ALLOWED_EMAILS") ?? "") {
  return new Set(
    value
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  return !!email && allowedEmailSet().has(email.trim().toLowerCase());
}
