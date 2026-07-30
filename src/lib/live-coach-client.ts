import type { LiveCoachMessage } from "@/services/live-coaching";
import {
  parseLiveCoachStreamLine,
  takeLiveCoachStreamEvents,
  type LiveCoachStreamEvent,
} from "@/lib/live-coach-stream";

const LIVE_COACH_CLIENT_EVENT = "live-coach-client-event";
const LIVE_COACH_BROADCAST_CHANNEL = "workout-tracker-live-coach";

export type LiveCoachClientEvent =
  | {
      type: "saved";
      ownerId: string;
      sessionId: string;
      clientKey: string;
      userMessage: LiveCoachMessage;
      pendingResponse: LiveCoachMessage | null;
    }
  | {
      type: "stream";
      ownerId: string;
      sessionId: string;
      responseId: string;
      event: LiveCoachStreamEvent;
    }
  | {
      type: "stream_error";
      ownerId: string;
      sessionId: string;
      responseId: string;
      reason: string;
    };

let broadcastChannel: BroadcastChannel | null | undefined;

function getBroadcastChannel() {
  if (broadcastChannel !== undefined) return broadcastChannel;
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    broadcastChannel = null;
    return broadcastChannel;
  }
  broadcastChannel = new BroadcastChannel(LIVE_COACH_BROADCAST_CHANNEL);
  return broadcastChannel;
}

export function publishLiveCoachClientEvent(event: LiveCoachClientEvent) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LiveCoachClientEvent>(LIVE_COACH_CLIENT_EVENT, {
      detail: event,
    })
  );
  getBroadcastChannel()?.postMessage(event);
}

export function subscribeToLiveCoachClientEvents(
  listener: (event: LiveCoachClientEvent) => void
) {
  if (typeof window === "undefined") return () => undefined;
  const onLocalEvent = (event: Event) => {
    listener((event as CustomEvent<LiveCoachClientEvent>).detail);
  };
  const onBroadcast = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (value && typeof value === "object" && "type" in value) {
      listener(value as LiveCoachClientEvent);
    }
  };
  const channel = getBroadcastChannel();
  window.addEventListener(LIVE_COACH_CLIENT_EVENT, onLocalEvent);
  channel?.addEventListener("message", onBroadcast);
  return () => {
    window.removeEventListener(LIVE_COACH_CLIENT_EVENT, onLocalEvent);
    channel?.removeEventListener("message", onBroadcast);
  };
}

export async function streamLiveCoachResponse(input: {
  responseId: string;
  activeRestTimerSeconds: number | null;
  onEvent: (event: LiveCoachStreamEvent) => void;
}) {
  const result = await fetch("/api/live-coach/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      responseId: input.responseId,
      activeRestTimerSeconds: input.activeRestTimerSeconds,
    }),
  });
  if (!result.ok) {
    const issue = (await result.json().catch(() => null)) as {
      reason?: string;
    } | null;
    throw new Error(issue?.reason ?? "Live Coach could not start that reply.");
  }
  if (!result.body) {
    throw new Error("Live Coach did not return a response stream.");
  }

  const reader = result.body.getReader();
  const decoder = new TextDecoder();
  let terminalEventReceived = false;
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = takeLiveCoachStreamEvents(buffer);
    buffer = parsed.remainder;
    for (const event of parsed.events) {
      input.onEvent(event);
      if (event.type === "completed" || event.type === "failed") {
        terminalEventReceived = true;
      }
    }
  }
  buffer += decoder.decode();
  const trailing = parseLiveCoachStreamLine(buffer);
  if (trailing) {
    input.onEvent(trailing);
    if (trailing.type === "completed" || trailing.type === "failed") {
      terminalEventReceived = true;
    }
  }
  if (!terminalEventReceived) {
    throw new Error("The connection closed before Coach finished replying.");
  }
}
