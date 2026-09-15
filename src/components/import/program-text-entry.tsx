"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ProgramEditor } from "@/components/program/program-editor";
import { RoutineImport } from "@/components/import/routine-import";
import type { ComponentProps } from "react";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";

export function ProgramTextEntry({
  ownerId,
  library,
  canUpdate,
  ...props
}: ComponentProps<typeof RoutineImport> & {
  ownerId: string;
  library: ExerciseDiscoveryItem[];
  canUpdate: boolean;
}) {
  const [updateText, setUpdateText] = useState<string | null>(null);
  if (updateText !== null)
    return (
      <div className="space-y-3">
        <Button variant="outline" onClick={() => setUpdateText(null)}>
          Back to routine import
        </Button>
        <ProgramEditor
          ownerId={ownerId}
          library={library}
          initialPrompt={updateText}
          initialDayId={null}
          initialRemovalRequest={null}
          initialReplacementRequest={null}
        />
      </div>
    );
  return (
    <RoutineImport
      {...props}
      onUpdateCurrent={canUpdate ? (text) => setUpdateText(text) : undefined}
    />
  );
}
