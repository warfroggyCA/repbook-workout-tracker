"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  clearActiveWorkoutMeasurements,
  ACTIVE_WORKOUT_MEASUREMENT_CHANGE_EVENT,
  ACTIVE_WORKOUT_MEASUREMENT_STORAGE_KEY,
  readActiveWorkoutMeasurements,
  type ActiveWorkoutSetMeasurement,
} from "@/lib/active-workout-measurements";

export function WorkoutMeasurementsDrawer() {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<ActiveWorkoutSetMeasurement[]>([]);

  useEffect(() => {
    if (!open) return;
    const refresh = () => setRecords(readActiveWorkoutMeasurements());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_WORKOUT_MEASUREMENT_STORAGE_KEY) refresh();
    };
    window.addEventListener(ACTIVE_WORKOUT_MEASUREMENT_CHANGE_EVENT, refresh);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(ACTIVE_WORKOUT_MEASUREMENT_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", handleStorage);
    };
  }, [open]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) setRecords(readActiveWorkoutMeasurements());
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerTrigger render={<Button type="button" variant="ghost" size="sm" />}>
        Friction log
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Active-workout friction log</DrawerTitle>
          <DrawerDescription>
            Device-only, bounded to 100 set records and 30 days. It contains timings and counts, never exercise names, notes, or Coach content.
          </DrawerDescription>
        </DrawerHeader>
        <div className="max-h-[55dvh] overflow-y-auto px-4 pb-6">
          {records.length === 0 ? (
            <p className="text-sm text-muted-foreground">No set measurements yet.</p>
          ) : (
            <ul className="space-y-2" aria-label="Set friction measurements">
              {[...records].reverse().map((record) => (
                <li key={record.clientKey} className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">
                    {record.outcome} · {record.durationMs == null ? "awaiting acknowledgement" : `${(record.durationMs / 1000).toFixed(1)} seconds`}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {record.taps} taps · {record.focusChanges} focus changes · {record.corrections} corrections
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(record.submittedAtISO).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DrawerFooter>
          <Button
            type="button"
            variant="outline"
            disabled={records.length === 0}
            onClick={() => {
              clearActiveWorkoutMeasurements();
              setRecords([]);
            }}
          >
            Clear friction log
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
