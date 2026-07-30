import { sensitiveJson } from "@/lib/http-security";

export type SameOriginDecision =
  | { ok: true }
  | { ok: false; reason: "missing_browser_origin" | "origin_mismatch" | "cross_site" };

function firstForwardedValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() || null;
}

export function requestOriginMatches(request: Request, origin: string): boolean {
  try {
    const candidate = new URL(origin);
    if (
      candidate.username ||
      candidate.password ||
      candidate.pathname !== "/" ||
      candidate.search ||
      candidate.hash
    ) {
      return false;
    }

    const requestUrl = new URL(request.url);
    const forwardedHost = firstForwardedValue(
      request.headers.get("x-forwarded-host")
    );
    const forwardedProtocol = firstForwardedValue(
      request.headers.get("x-forwarded-proto")
    )?.replace(/:$/, "");
    const hosts = new Set(
      [forwardedHost, request.headers.get("host"), requestUrl.host]
        .map((value) => value?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value))
    );
    const protocols = new Set(
      [forwardedProtocol, requestUrl.protocol.replace(/:$/, "")]
        .map((value) => value?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value))
    );
    return (
      hosts.has(candidate.host.toLowerCase()) &&
      protocols.has(candidate.protocol.slice(0, -1).toLowerCase())
    );
  } catch {
    return false;
  }
}

/**
 * Cookie-authenticated browser mutations must carry browser provenance.
 * A matching Origin or Sec-Fetch-Site=same-origin is accepted; explicit
 * cross-site/same-site provenance and requests missing both signals are denied.
 */
export function validateSameOriginMutation(request: Request): SameOriginDecision {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();

  if (origin && !requestOriginMatches(request, origin)) {
    return { ok: false, reason: "origin_mismatch" };
  }
  if (fetchSite && fetchSite !== "same-origin") {
    return { ok: false, reason: "cross_site" };
  }
  if (!origin && !fetchSite) {
    return { ok: false, reason: "missing_browser_origin" };
  }
  return { ok: true };
}

export function sameOriginMutationFailure(request: Request): Response | null {
  const decision = validateSameOriginMutation(request);
  return decision.ok
    ? null
    : sensitiveJson({ ok: false, reason: "Forbidden" }, { status: 403 });
}
