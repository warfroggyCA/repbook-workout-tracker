export const SENSITIVE_CACHE_CONTROL = "private, no-store";

export function sensitiveHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", SENSITIVE_CACHE_CONTROL);
  }
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export function sensitiveResponse(
  body?: BodyInit | null,
  init: ResponseInit = {}
): Response {
  return new Response(body, {
    ...init,
    headers: sensitiveHeaders(init.headers),
  });
}

export function sensitiveJson(
  body: unknown,
  init: ResponseInit = {}
): Response {
  return Response.json(body, {
    ...init,
    headers: sensitiveHeaders(init.headers),
  });
}
