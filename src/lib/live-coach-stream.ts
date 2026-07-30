import type { LiveCoachMessage } from "@/services/live-coaching";

export type LiveCoachStreamEvent =
  | { type: "ready"; responseId: string }
  | { type: "partial"; responseId: string; answer: string }
  | { type: "completed"; response: LiveCoachMessage }
  | {
      type: "failed";
      response: LiveCoachMessage | null;
      reason: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isLiveCoachMessage(value: unknown): value is LiveCoachMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    (value.author === "user" || value.author === "assistant") &&
    (value.responseStatus === "saved" ||
      value.responseStatus === "pending" ||
      value.responseStatus === "completed" ||
      value.responseStatus === "failed")
  );
}

export function encodeLiveCoachStreamEvent(event: LiveCoachStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

export function parseLiveCoachStreamLine(
  line: string
): LiveCoachStreamEvent | null {
  if (!line.trim()) return null;
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Live Coach returned an invalid stream event.");
  }
  if (
    value.type === "ready" &&
    typeof value.responseId === "string"
  ) {
    return { type: "ready", responseId: value.responseId };
  }
  if (
    value.type === "partial" &&
    typeof value.responseId === "string" &&
    typeof value.answer === "string"
  ) {
    return {
      type: "partial",
      responseId: value.responseId,
      answer: value.answer,
    };
  }
  if (value.type === "completed" && isLiveCoachMessage(value.response)) {
    return { type: "completed", response: value.response };
  }
  if (
    value.type === "failed" &&
    typeof value.reason === "string" &&
    (value.response == null || isLiveCoachMessage(value.response))
  ) {
    return {
      type: "failed",
      response: value.response ?? null,
      reason: value.reason,
    };
  }
  throw new Error("Live Coach returned an unknown stream event.");
}

export function takeLiveCoachStreamEvents(buffer: string): {
  events: LiveCoachStreamEvent[];
  remainder: string;
} {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  return {
    events: lines
      .map(parseLiveCoachStreamLine)
      .filter((event): event is LiveCoachStreamEvent => event != null),
    remainder,
  };
}
