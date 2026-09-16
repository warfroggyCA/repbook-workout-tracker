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
  initialDayId = null,
  ...props
}: ComponentProps<typeof RoutineImport> & {
  ownerId: string;
  library: ExerciseDiscoveryItem[];
  canUpdate: boolean;
  initialDayId?: string | null;
}) {
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(
    canUpdate &&
      !props.initialParse &&
      props.initialDestination !== "create_new_active",
  );
  const [hasEdited, setHasEdited] = useState(editing);
  return (
    <div>
      {hasEdited && (
        <div hidden={!editing} className="space-y-3">
          <Button variant="outline" onClick={() => setEditing(false)}>
            Import a complete routine instead
          </Button>
          <ProgramEditor
            ownerId={ownerId}
            library={library}
            initialPrompt={input}
            onPromptChange={setInput}
            editorPath="/program/import"
            initialDayId={initialDayId}
            initialRemovalRequest={null}
            initialReplacementRequest={null}
          />
        </div>
      )}
      {!editing && (
        <RoutineImport
          {...props}
          initialInput={input}
          onInputChange={setInput}
          onUpdateCurrent={
            canUpdate
              ? (text) => {
                  setInput(text);
                  setHasEdited(true);
                  setEditing(true);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
