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
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(
    canUpdate &&
      !props.initialParse &&
      props.initialDestination !== "create_new_active",
  );
  if (editing)
    return (
      <div className="space-y-3">
        <Button variant="outline" onClick={() => setEditing(false)}>
          Import a complete routine instead
        </Button>
        <ProgramEditor
          ownerId={ownerId}
          library={library}
          initialPrompt={input}
          onPromptChange={setInput}
          initialDayId={null}
          initialRemovalRequest={null}
          initialReplacementRequest={null}
        />
      </div>
    );
  return (
    <RoutineImport
      {...props}
      initialInput={input}
      onInputChange={setInput}
      onUpdateCurrent={
        canUpdate
          ? (text) => {
              setInput(text);
              setEditing(true);
            }
          : undefined
      }
    />
  );
}
