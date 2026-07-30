"use client";

import { Check, Plus } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import {
  addSupersetGroup,
  canCreateSuperset,
  gatherProgramSlots,
} from "@/lib/program-editor-client";
import type { ProgramDocumentDayV3 } from "@/lib/program-document";

export const SupersetControls = memo(function SupersetControls({
  day,
  dayIndex,
  pairingDayId,
  pairingSlotIds,
  setPairingDayId,
  setPairingSlotIds,
  updateDay,
}: {
  day: ProgramDocumentDayV3;
  dayIndex: number;
  pairingDayId: string | null;
  pairingSlotIds: string[];
  setPairingDayId: (value: string | null) => void;
  setPairingSlotIds: (value: string[]) => void;
  updateDay: (
    dayIndex: number,
    updater: (day: ProgramDocumentDayV3) => ProgramDocumentDayV3,
  ) => void;
}) {
  return (
    <>
      {pairingDayId !== day.lineageId && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={!canCreateSuperset(day)}
          onClick={() => {
            setPairingDayId(day.lineageId);
            setPairingSlotIds([]);
          }}
        >
          <Plus /> Group exercises
        </Button>
      )}

      {pairingDayId === day.lineageId && (
        <div className="rounded-lg border border-primary/30 bg-background p-3">
          <p className="font-medium">
            Select at least two unpaired exercises below.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {pairingSlotIds.length} selected
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pairingSlotIds.length < 2}
              onClick={() => {
                const key = crypto.randomUUID();
                updateDay(dayIndex, (current) => {
                  const plannedRounds = current.exercises.find((slot) =>
                    pairingSlotIds.includes(slot.lineageId),
                  )?.sets ?? 3;
                  const grouped = addSupersetGroup(current, {
                    key,
                    name: `Superset ${current.supersets.length + 1}`,
                    structureStatus: "canonical",
                    plannedRounds,
                    restBetweenMembersSec: 0,
                    restBetweenRoundsSec: 90,
                    restAfterRoundSec: 90,
                  }, pairingSlotIds);
                  const selected = grouped.exercises.map((slot) =>
                    pairingSlotIds.includes(slot.lineageId)
                      ? {
                          ...slot,
                          sets: plannedRounds,
                          setNotes: Array.from(
                            { length: plannedRounds },
                            (_, index) => slot.setNotes[index] ?? null,
                          ),
                        }
                      : slot,
                  );
                  return {
                    ...grouped,
                    exercises: gatherProgramSlots(
                    selected,
                    pairingSlotIds,
                    key,
                  ),
                  };
                });
                setPairingDayId(null);
                setPairingSlotIds([]);
              }}
            >
              <Check /> Make superset
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPairingDayId(null);
                setPairingSlotIds([]);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  );
});
