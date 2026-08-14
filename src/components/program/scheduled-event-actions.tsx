"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, SkipForward } from "lucide-react";
import {
  adjustScheduledEventAction,
  completeScheduledEventAction,
} from "@/app/actions/program-schedules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ScheduledEventActions({
  eventId,
  revision,
  eventKind,
  scheduleKind,
  currentLocalDate,
  allowComplete,
}: {
  eventId: string;
  revision: number;
  eventKind: "resistance" | "cardio" | "recovery" | "rest";
  scheduleKind: "fixed_7_day" | "rolling";
  currentLocalDate: string;
  allowComplete: boolean;
}) {
  const router = useRouter();
  const requestIds = useRef<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(currentLocalDate);
  const [shiftDays, setShiftDays] = useState(1);

  function requestId(key: string) {
    requestIds.current[key] ??= crypto.randomUUID();
    return requestIds.current[key];
  }

  function finish(key: string, task: () => Promise<{ ok: boolean; reason?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) {
        setError(result.reason ?? "The schedule did not change.");
        return;
      }
      delete requestIds.current[key];
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {allowComplete && eventKind !== "resistance" && (
          <Button disabled={pending} onClick={() => finish("complete", () => completeScheduledEventAction({ eventId, expectedRevision: revision, requestId: requestId("complete") }))}>
            <Check /> {pending ? "Saving…" : "Mark complete"}
          </Button>
        )}
        <Button variant="outline" disabled={pending} onClick={() => {
          if (!window.confirm("Skip this scheduled event? It will remain recorded as skipped.")) return;
          finish("skip", () => adjustScheduledEventAction({ eventId, expectedRevision: revision, requestId: requestId("skip"), adjustment: { kind: "skip" } }));
        }}>
          <SkipForward /> Skip
        </Button>
      </div>
      <div className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="text-xs font-medium">Move only this event<Input className="mt-1 min-h-11" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <Button variant="outline" disabled={pending || date === currentLocalDate} onClick={() => finish(`date:${date}`, () => adjustScheduledEventAction({ eventId, expectedRevision: revision, requestId: requestId(`date:${date}`), adjustment: { kind: "manual_reschedule", toLocalDate: date } }))}>
          <CalendarClock /> Reschedule
        </Button>
      </div>
      {scheduleKind === "rolling" && (
        <div className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="text-xs font-medium">Shift this and later rotation days<Input className="mt-1 min-h-11" type="number" inputMode="numeric" min={1} max={3650} value={shiftDays} onChange={(event) => setShiftDays(Math.max(1, Math.trunc(Number(event.target.value)) || 1))} /></label>
          <Button variant="outline" disabled={pending} onClick={() => {
            if (!window.confirm(`Shift this and later events by ${shiftDays} day${shiftDays === 1 ? "" : "s"}?`)) return;
            finish(`shift:${shiftDays}`, () => adjustScheduledEventAction({ eventId, expectedRevision: revision, requestId: requestId(`shift:${shiftDays}`), adjustment: { kind: "shift_rolling", days: shiftDays } }));
          }}>
            Shift rotation
          </Button>
        </div>
      )}
      {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
