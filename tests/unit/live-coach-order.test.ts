import { describe, expect, it } from "vitest";
import {
  isRetryableFailedResponse,
  sortConversationMessages,
} from "@/lib/live-coach-order";

describe("Live Coach conversation ordering", () => {
  it("keeps a question before its answer when both share a timestamp", () => {
    const createdAtISO = "2026-07-11T12:00:00.000Z";
    const messages = sortConversationMessages([
      { id: "answer", replyToId: "question", createdAtISO },
      { id: "question", replyToId: null, createdAtISO },
    ]);

    expect(messages.map((message) => message.id)).toEqual(["question", "answer"]);
  });

  it("keeps retries with their original question", () => {
    const messages = sortConversationMessages([
      {
        id: "later-question",
        replyToId: null,
        createdAtISO: "2026-07-11T12:00:01.000Z",
      },
      {
        id: "retry",
        replyToId: "first-question",
        createdAtISO: "2026-07-11T12:00:02.000Z",
      },
      {
        id: "first-question",
        replyToId: null,
        createdAtISO: "2026-07-11T12:00:00.000Z",
      },
      {
        id: "first-answer",
        replyToId: "first-question",
        createdAtISO: "2026-07-11T12:00:00.000Z",
      },
    ]);

    expect(messages.map((message) => message.id)).toEqual([
      "first-question",
      "first-answer",
      "retry",
      "later-question",
    ]);
  });

  it("offers retry only on the latest failed attempt until a reply succeeds", () => {
    const firstFailure = {
      id: "failed-1",
      replyToId: "question",
      createdAtISO: "2026-07-11T12:00:01.000Z",
      responseStatus: "failed" as const,
    };
    const secondFailure = {
      ...firstFailure,
      id: "failed-2",
      createdAtISO: "2026-07-11T12:00:02.000Z",
    };
    expect(
      isRetryableFailedResponse(firstFailure, [firstFailure, secondFailure])
    ).toBe(false);
    expect(
      isRetryableFailedResponse(secondFailure, [firstFailure, secondFailure])
    ).toBe(true);

    const completed = {
      ...secondFailure,
      id: "completed",
      responseStatus: "completed" as const,
    };
    expect(
      isRetryableFailedResponse(secondFailure, [
        firstFailure,
        secondFailure,
        completed,
      ])
    ).toBe(false);
  });
});
