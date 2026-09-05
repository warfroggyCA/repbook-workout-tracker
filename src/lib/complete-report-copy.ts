// A clipboard convenience budget, not a report/export truncation limit.
export const COMPLETE_REPORT_COPY_MAX_BYTES = 1024 * 1024;
export const COMPLETE_REPORT_PREPARE_TIMEOUT_MS = 30_000;
export const COMPLETE_REPORT_COPY_TOO_LARGE =
  "This complete report is too large to copy safely on this device. Download the complete report file instead; no records are omitted.";

export async function readCompleteReportForCopy(response: Response): Promise<{ text: string; bytes: number }> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(response.status === 429
      ? "A report is already being prepared, or was just prepared. Wait briefly and try again."
      : "The report could not be prepared. Try again.");
  }
  if (Number(response.headers.get("Content-Length")) > COMPLETE_REPORT_COPY_MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error(COMPLETE_REPORT_COPY_TOO_LARGE);
  }
  if (!response.body) throw new Error("The report is empty. Try again.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > COMPLETE_REPORT_COPY_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error(COMPLETE_REPORT_COPY_TOO_LARGE);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  if (!bytes) throw new Error("The report is empty. Try again.");
  return { text: parts.join(""), bytes };
}
