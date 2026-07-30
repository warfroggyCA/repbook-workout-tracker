import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerEvent } from "@/lib/server-log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server event logger", () => {
  it("writes one structured JSON line and truncates every supplied string", () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logServerEvent("error", "test.event", {
      id: "record-1",
      message: "x".repeat(700),
      attempts: 2,
      retrying: true,
      optional: null,
    });

    expect(write).toHaveBeenCalledTimes(1);
    const event = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(event).toMatchObject({
      level: "error",
      event: "test.event",
      id: "record-1",
      attempts: 2,
      retrying: true,
      optional: null,
    });
    expect(event.message).toHaveLength(500);
    expect(new Date(event.at).toISOString()).toBe(event.at);
  });

  it("never throws when output itself fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout unavailable");
    });

    expect(() => logServerEvent("warn", "test.output_failed")).not.toThrow();
  });
});
