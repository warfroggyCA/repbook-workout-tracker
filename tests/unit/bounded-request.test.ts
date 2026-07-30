import { describe, expect, it } from "vitest";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";

function streamingRequest(
  chunks: Uint8Array[],
  onCancel?: () => void
) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Request("http://localhost/upload", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("bounded request bodies", () => {
  it("joins a chunked body that remains within its byte limit", async () => {
    const body = await readBoundedRequestBody(
      streamingRequest([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
      ]),
      6
    );

    expect([...body]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("cancels a chunked body as soon as streamed bytes exceed the limit", async () => {
    let cancelled = false;
    const request = streamingRequest(
      [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)],
      () => {
        cancelled = true;
      }
    );

    await expect(readBoundedRequestBody(request, 6)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError
    );
    expect(cancelled).toBe(true);
  });
});
