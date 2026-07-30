"use client";

import { useState, useTransition } from "react";
import { saveTimezonePreference } from "@/app/actions/settings";
import { Button } from "@/components/ui/button";

export function TimezoneControl({ current }: { current: string }) {
  const [savedTimezone, setSavedTimezone] = useState(current);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!detected) {
      setError("This browser did not report a timezone.");
      return;
    }
    setSaved(false);
    setError(null);
    startTransition(async () => {
      const result = await saveTimezonePreference(detected);
      if (result.ok) {
        setSavedTimezone(detected);
        setSaved(true);
      } else setError(result.reason);
    });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
        Workout timezone:{" "}
        <span className="break-words text-foreground [overflow-wrap:anywhere]">
          {savedTimezone}
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        className="h-auto min-h-7 max-w-full whitespace-normal text-left"
        onClick={save}
      >
        Use this device’s timezone
      </Button>
      <span className="text-xs text-muted-foreground" aria-live="polite">
        {pending
          ? "Saving…"
          : error ?? (saved ? `Saved ${savedTimezone}.` : "")}
      </span>
    </div>
  );
}
