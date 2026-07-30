import { isDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";

export function buildContentSecurityPolicy(
  nonce: string,
  environment: "development" | "production" =
    process.env.NODE_ENV === "development" ? "development" : "production"
) {
  const development = environment === "development";
  const localHttpAcceptance = isDisposableAcceptanceRuntime();
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    ...(development || localHttpAcceptance
      ? []
      : ["upgrade-insecure-requests"]),
  ].join("; ");
}
