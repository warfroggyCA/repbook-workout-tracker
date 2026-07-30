import type {
  ContextualNoteAttachmentKind,
  ContextualNoteCapturedContext,
} from "@/lib/contextual-note-contract";

export const CONTEXTUAL_NOTE_SCOPE_EVENT = "contextual-note-scope-change";
export const CONTEXTUAL_NOTE_OPEN_EVENT = "contextual-note-open";

export type ContextualNoteAttachmentChoice = {
  key: string;
  kind: ContextualNoteAttachmentKind;
  label: string;
  sessionId?: string;
  sessionExerciseId?: string;
  occurrenceId?: string;
  completedSetId?: string | null;
  programId?: string;
  programVersionId?: string;
  workoutTemplateId?: string;
  workoutTemplateExerciseId?: string;
};

export type ContextualNoteScopeValue = {
  scopeId: string;
  capturedContext: ContextualNoteCapturedContext;
  attachments: ContextualNoteAttachmentChoice[];
  defaultAttachmentKey: string;
};

export function resolveContextualNoteComposerOpening(input: {
  draftBody: string;
  currentScope: ContextualNoteScopeValue;
  currentAttachmentKey: string;
  requestedScope: ContextualNoteScopeValue;
}) {
  if (input.draftBody.trim().length > 0) {
    return {
      scope: input.currentScope,
      attachmentKey: input.currentAttachmentKey,
      retainedFromDifferentScope:
        input.currentScope.scopeId !== input.requestedScope.scopeId,
    };
  }

  return {
    scope: input.requestedScope,
    attachmentKey: input.requestedScope.defaultAttachmentKey,
    retainedFromDifferentScope: false,
  };
}

export function publishContextualNoteScope(
  scope: ContextualNoteScopeValue | null,
) {
  window.dispatchEvent(
    new CustomEvent<ContextualNoteScopeValue | null>(
      CONTEXTUAL_NOTE_SCOPE_EVENT,
      { detail: scope },
    ),
  );
}

export function openContextualNoteComposer() {
  window.dispatchEvent(new Event(CONTEXTUAL_NOTE_OPEN_EVENT));
}

export function contextualNoteDictationBlockedReason(typedDraft: string) {
  return typedDraft.trim().length > 0
    ? "Save or explicitly discard the typed draft before confirming dictation."
    : null;
}

export function generalContextualNoteScope(input: {
  scopeId: string;
  destination: ContextualNoteCapturedContext["destination"];
  workflow: string;
  originatedFromSimulation?: boolean;
}): ContextualNoteScopeValue {
  return {
    scopeId: input.scopeId,
    capturedContext: {
      schemaVersion: 1,
      destination: input.destination,
      workflow: input.workflow,
      workoutPhase: null,
      originatedFromSimulation: input.originatedFromSimulation ?? false,
      programDay: null,
      plannedExercise: null,
      performedExercise: null,
      occurrence: null,
      loadRepetitions: null,
      restContext: null,
      reviewContext: null,
    },
    attachments: [{ key: "general", kind: "general", label: "General training note" }],
    defaultAttachmentKey: "general",
  };
}
