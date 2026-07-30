import { describe, expect, it } from "vitest";
import {
  encodeLiveCoachStreamEvent,
  parseLiveCoachStreamLine,
  takeLiveCoachStreamEvents,
} from "@/lib/live-coach-stream";
import type { LiveCoachMessage } from "@/services/live-coaching";

function completedResponse(): LiveCoachMessage {
  return {
    id: "response-id",
    sessionId: "session-id",
    sessionExerciseId: null,
    completedSetId: null,
    replyToId: "question-id",
    author: "assistant",
    messageKind: "answer",
    inputMode: "text",
    responseStatus: "completed",
    content: "",
    answer: {
      answer: "Hold the load and reassess after the next set.",
      evidence: ["One set is logged."],
      dataGaps: [],
      safetyNote: null,
    },
    model: "test-model",
    failureReason: null,
    createdAtISO: "2026-07-12T12:00:00.000Z",
    completedAtISO: "2026-07-12T12:00:01.000Z",
  };
}

describe("Live Coach stream protocol", () => {
  it("reassembles split chunks and ignores the WebKit padding line", () => {
    const payload =
      `${" ".repeat(1024)}\n` +
      encodeLiveCoachStreamEvent({ type: "ready", responseId: "response-id" }) +
      encodeLiveCoachStreamEvent({
        type: "partial",
        responseId: "response-id",
        answer: "Hold the load",
      }) +
      encodeLiveCoachStreamEvent({
        type: "completed",
        response: completedResponse(),
      });
    const splitAt = payload.indexOf("Hold the load") + 5;

    const first = takeLiveCoachStreamEvents(payload.slice(0, splitAt));
    expect(first.events.map((event) => event.type)).toEqual(["ready"]);

    const second = takeLiveCoachStreamEvents(
      first.remainder + payload.slice(splitAt)
    );
    expect(second.remainder).toBe("");
    expect(second.events.map((event) => event.type)).toEqual([
      "partial",
      "completed",
    ]);
    expect(second.events[0]).toMatchObject({ answer: "Hold the load" });
    expect(second.events[1]).toMatchObject({
      response: { responseStatus: "completed" },
    });
  });

  it("rejects unknown events instead of treating them as transcript data", () => {
    expect(() =>
      parseLiveCoachStreamLine(JSON.stringify({ type: "mutation", set: 2 }))
    ).toThrow("unknown stream event");
  });
});
