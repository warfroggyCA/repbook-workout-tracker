"use client";

import { Label } from "@/components/ui/label";
import {
  formatRestTime,
  REST_SECOND_CHOICES,
  restTimeFromParts,
  restTimeParts,
} from "@/lib/rest-time";

export function RestTimeControl({
  id,
  value,
  onChange,
  maxMinutes = 30,
  label = "Rest",
}: {
  id: string;
  value: number;
  onChange: (seconds: number) => void;
  maxMinutes?: number;
  label?: string;
}) {
  const parts = restTimeParts(value);
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="sr-only" htmlFor={`${id}-minutes`}>Minutes</Label>
          <select
            id={`${id}-minutes`}
            className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={parts.minutes}
            onChange={(event) =>
              onChange(restTimeFromParts(Number(event.target.value), parts.seconds))
            }
          >
            {Array.from({ length: maxMinutes + 1 }, (_, minute) => (
              <option key={minute} value={minute}>{minute} min</option>
            ))}
          </select>
        </div>
        <div>
          <Label className="sr-only" htmlFor={`${id}-seconds`}>Seconds</Label>
          <select
            id={`${id}-seconds`}
            className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={parts.isCustom ? parts.seconds : String(parts.seconds)}
            onChange={(event) =>
              onChange(restTimeFromParts(parts.minutes, Number(event.target.value)))
            }
          >
            {parts.isCustom && (
              <option value={parts.seconds}>Custom: {parts.seconds} sec</option>
            )}
            {REST_SECOND_CHOICES.map((seconds) => (
              <option key={seconds} value={seconds}>{seconds} sec</option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{formatRestTime(value)}</p>
    </fieldset>
  );
}
