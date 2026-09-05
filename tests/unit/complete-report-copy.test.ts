import { describe, expect, it, vi } from "vitest";
import { COMPLETE_REPORT_COPY_MAX_BYTES, readCompleteReportForCopy } from "@/lib/complete-report-copy";

describe("bounded complete report clipboard preparation", () => {
  it("preserves split UTF-8 and the complete report at the byte limit", async () => {
    const bytes = new TextEncoder().encode("é" + "x".repeat(COMPLETE_REPORT_COPY_MAX_BYTES - 2));
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 1));
      controller.enqueue(bytes.slice(1));
      controller.close();
    } }));
    expect(await readCompleteReportForCopy(response)).toEqual({
      text: "é" + "x".repeat(COMPLETE_REPORT_COPY_MAX_BYTES - 2), bytes: COMPLETE_REPORT_COPY_MAX_BYTES,
    });
  });
  it.each([true, false])("cancels oversized data with or without an honest length header (%s)", async (hasLength) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(COMPLETE_REPORT_COPY_MAX_BYTES + 1)); }, cancel,
    }), { headers: { "Content-Length": hasLength ? String(COMPLETE_REPORT_COPY_MAX_BYTES + 1) : "1" } });
    await expect(readCompleteReportForCopy(response)).rejects.toThrow(/too large.*Download/);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([429, 500, 401])("does not retain or disclose an error body (%i)", async (status) => {
    await expect(readCompleteReportForCopy(new Response("private internal detail", { status })))
      .rejects.toThrow(status === 429 ? /Wait briefly/ : /could not be prepared/);
  });
  it("rejects an empty report and an interrupted stream without claiming readiness", async () => {
    await expect(readCompleteReportForCopy(new Response(""))).rejects.toThrow(/empty/);
    await expect(readCompleteReportForCopy(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      controller.error(new Error("interrupted"));
    } })))).rejects.toThrow(/interrupted/);
  });
});
