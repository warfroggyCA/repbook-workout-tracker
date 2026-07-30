export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeded ${maxBytes} bytes.`);
    this.name = "RequestBodyTooLargeError";
  }
}

/** Reads a web request without ever accepting more than the declared limit. */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number
): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("A positive request-body limit is required.");
  }
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader != null) {
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new Error("The request Content-Length is invalid.");
    }
    if (declared > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
