"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import { formatProgramReviewValue, type ProgramHistoryEntry } from "@/lib/program-editor-client";
import type { StoredProgramDocument } from "@/lib/program-document";
import { formatRestTime } from "@/lib/rest-time";

function displayLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function VersionInspection({
  entry,
  document,
  exerciseById,
  headingRef,
  onClose,
}: {
  entry: ProgramHistoryEntry;
  document: StoredProgramDocument;
  exerciseById: Map<string, ExerciseDiscoveryItem>;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="text-lg font-semibold outline-none"
              >
                Inspect v{entry.versionNo} · {document.name}
              </h2>
            </CardTitle>
            <CardDescription>
              This is the immutable plan published for this version.
            </CardDescription>
          </div>
          <Button type="button" variant="outline" onClick={onClose}>
            Close inspection
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {document.days.map((day, dayIndex) => {
          const groupNames = new Map(
            day.supersets.map((group) => [group.key, group.name]),
          );
          return (
            <section
              key={day.lineageId}
              aria-labelledby={`inspection-${entry.id}-${day.lineageId}`}
              className="rounded-lg border p-3"
            >
              <h3
                id={`inspection-${entry.id}-${day.lineageId}`}
                className="font-semibold"
              >
                Day {dayIndex + 1} · {day.name}
              </h3>
              {day.notes && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {day.notes}
                </p>
              )}
              {day.supersets.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {day.supersets.map((group) => (
                    <li key={group.key}>
                      {group.name}: {formatRestTime(group.restAfterRoundSec)} between
                      rounds
                    </li>
                  ))}
                </ul>
              )}
              <ol className="mt-3 space-y-3">
                {day.exercises.map((slot, slotIndex) => (
                  <li
                    key={slot.lineageId}
                    className="rounded-lg bg-muted/30 p-3"
                  >
                    <h4 className="font-medium">
                      {slotIndex + 1}.{" "}
                      {exerciseById.get(slot.exerciseId)?.name ??
                        "Unavailable exercise"}
                    </h4>
                    <p className="mt-1 text-sm">
                      {slot.sets} sets · {slot.timedPrescription ? `${slot.timedPrescription.minSeconds}–${slot.timedPrescription.maxSeconds} sec/side` : `${slot.repMin}–${slot.repMax} reps`} ·{" "}
                      {slot.targetLoad == null
                        ? "no target load"
                        : `${slot.targetLoad} ${slot.targetLoadUnit}`}{" "}
                      · {formatRestTime(slot.restSec)} rest
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {displayLabel(slot.progressionRuleId)}
                      {slot.supersetKey
                        ? ` · ${groupNames.get(slot.supersetKey) ?? "Superset"}`
                        : ""}
                    </p>
                    {slot.notes && <p className="mt-2 text-sm">{slot.notes}</p>}
                    {slot.setNotes.some(Boolean) && (
                      <p className="mt-2 text-sm">
                        Work-set cues: {formatProgramReviewValue(slot.setNotes)}
                      </p>
                    )}
                    {slot.warmupNotes && (
                      <p className="mt-2 text-sm">
                        Warm-up: {slot.warmupNotes}
                      </p>
                    )}
                    {slot.warmupSets.length > 0 && (
                      <p className="mt-2 text-sm">
                        Warm-up sets:{" "}
                        {formatProgramReviewValue(slot.warmupSets)}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
