export const PERMANENT_DELETE_COOKIE = "wt_permanent_delete_grant";

export function permanentDeleteCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/archive",
    expires,
    priority: "high" as const,
  };
}
