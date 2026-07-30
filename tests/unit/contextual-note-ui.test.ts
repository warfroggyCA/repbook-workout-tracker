import { describe, expect, it } from "vitest";
import {
  contextualNoteDictationBlockedReason,
  generalContextualNoteScope,
  resolveContextualNoteComposerOpening,
} from "@/lib/contextual-note-ui";

describe("contextual note interaction rules", () => {
  it("never lets confirmed dictation silently replace a typed draft", () => {
    expect(contextualNoteDictationBlockedReason("typed observation")).toMatch(
      /save or explicitly discard/i,
    );
    expect(contextualNoteDictationBlockedReason("  ")).toBeNull();
  });

  it("keeps universal route access general and records its origin", () => {
    const scope = generalContextualNoteScope({
      scopeId: "route:settings",
      destination: "settings",
      workflow: "/settings",
    });
    expect(scope.attachments).toEqual([
      { key: "general", kind: "general", label: "General training note" },
    ]);
    expect(scope.capturedContext).toMatchObject({
      schemaVersion: 1,
      destination: "settings",
      workflow: "/settings",
      originatedFromSimulation: false,
    });
  });

  it("keeps a nonempty provider draft bound to its original route and attachment", () => {
    const originalScope = {
      ...generalContextualNoteScope({
        scopeId: "route:/session/session-1",
        destination: "workout",
        workflow: "/session/session-1",
      }),
      attachments: [
        { key: "workout", kind: "workout" as const, label: "Workout", sessionId: "session-1" },
        {
          key: "occurrence",
          kind: "occurrence" as const,
          label: "Set 2",
          sessionId: "session-1",
          occurrenceId: "occurrence-2",
        },
      ],
      defaultAttachmentKey: "workout",
    };
    const nextRouteScope = generalContextualNoteScope({
      scopeId: "route:/history",
      destination: "history",
      workflow: "/history",
    });

    const opening = resolveContextualNoteComposerOpening({
      draftBody: "Knee felt steadier on this occurrence",
      currentScope: originalScope,
      currentAttachmentKey: "occurrence",
      requestedScope: nextRouteScope,
    });

    expect(opening).toEqual({
      scope: originalScope,
      attachmentKey: "occurrence",
      retainedFromDifferentScope: true,
    });
  });

  it("lets an empty provider composer adopt the new route context", () => {
    const originalScope = generalContextualNoteScope({
      scopeId: "route:/today",
      destination: "today",
      workflow: "/today",
    });
    const nextRouteScope = generalContextualNoteScope({
      scopeId: "route:/program",
      destination: "program",
      workflow: "/program",
    });

    expect(
      resolveContextualNoteComposerOpening({
        draftBody: "  ",
        currentScope: originalScope,
        currentAttachmentKey: "general",
        requestedScope: nextRouteScope,
      }),
    ).toEqual({
      scope: nextRouteScope,
      attachmentKey: "general",
      retainedFromDifferentScope: false,
    });
  });

  it("does not keep an old attachment once the retained draft is explicitly emptied", () => {
    const originalScope = generalContextualNoteScope({
      scopeId: "route:/today",
      destination: "today",
      workflow: "/today",
    });
    const nextRouteScope = generalContextualNoteScope({
      scopeId: "route:/recovery",
      destination: "recovery",
      workflow: "/recovery",
    });

    expect(
      resolveContextualNoteComposerOpening({
        draftBody: "",
        currentScope: originalScope,
        currentAttachmentKey: "old-attachment",
        requestedScope: nextRouteScope,
      }),
    ).toMatchObject({
      scope: nextRouteScope,
      attachmentKey: nextRouteScope.defaultAttachmentKey,
    });
  });
});
