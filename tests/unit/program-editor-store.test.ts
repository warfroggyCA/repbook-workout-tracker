import { describe, expect, it } from "vitest";
import {
  initialProgramEditorState,
  programEditorReducer,
} from "@/components/program/editor/editor-store";
import type { ProgramDocumentV3 } from "@/lib/program-document";
import type { ServerDraft } from "@/lib/program-editor-client";

const document: ProgramDocumentV3 = {
  schemaVersion: "3",
  programId: "30000000-0000-4000-8000-000000000001",
  baseVersionId: "10000000-0000-4000-8000-000000000001",
  name: "Strength",
  days: [],
};

function draft(revision = 4): ServerDraft {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    revision,
    document,
    reviewedRevision: null,
    reviewHash: null,
    reviewSummary: null,
    reviewState: { status: "none" },
    history: [],
  };
}

describe("programEditorReducer", () => {
  it("loads a clean server draft", () => {
    const state = programEditorReducer(initialProgramEditorState, {
      type: "load",
      draft: draft(),
    });
    expect(state).toMatchObject({ revision: 4, document, dirty: false, status: "saved" });
  });

  it("marks an edit dirty and locally recovered", () => {
    const loaded = programEditorReducer(initialProgramEditorState, { type: "load", draft: draft() });
    const edited = { ...document, name: "Strength 2" };
    const state = programEditorReducer(loaded, {
      type: "edit",
      document: edited,
      mutationId: "mutation-1",
      recoverable: true,
    });
    expect(state).toMatchObject({ document: edited, dirty: true, pendingMutationId: "mutation-1", status: "local" });
  });

  it("accepts autosave success only for the current mutation", () => {
    const dirty = programEditorReducer(programEditorReducer(initialProgramEditorState, { type: "load", draft: draft() }), {
      type: "edit", document, mutationId: "mutation-1", recoverable: true,
    });
    const saved = programEditorReducer(dirty, { type: "autosave-success", revision: 5, mutationId: "mutation-1" });
    expect(saved).toMatchObject({ revision: 5, pendingMutationId: null, dirty: false, status: "saved" });
  });

  it("holds a server-ahead conflict without overwriting the local document", () => {
    const local = { ...document, name: "Local" };
    const dirty = programEditorReducer(programEditorReducer(initialProgramEditorState, { type: "load", draft: draft() }), {
      type: "edit", document: local, mutationId: "mutation-1", recoverable: true,
    });
    const server = { ...draft(5), document: { ...document, name: "Server" } };
    const state = programEditorReducer(dirty, { type: "server-conflict", draft: server });
    expect(state.document).toBe(local);
    expect(state).toMatchObject({ conflictDraft: server, dirty: true, status: "conflict" });
  });

  it("recovers a local document for later server save", () => {
    const local = { ...document, name: "Recovered" };
    const state = programEditorReducer(initialProgramEditorState, {
      type: "local-recovery", draft: draft(), document: local, mutationId: "mutation-local", offline: true,
    });
    expect(state).toMatchObject({ document: local, dirty: true, pendingMutationId: "mutation-local", status: "queued" });
  });

  it("hands a published draft back to the server lifecycle", () => {
    const state = programEditorReducer(programEditorReducer(initialProgramEditorState, { type: "load", draft: draft() }), {
      type: "publish-handoff", versionNo: 2,
    });
    expect(state).toMatchObject({ dirty: false, review: null, status: "published", message: "Version 2 is now current." });
  });

  it("discards all draft state", () => {
    const state = programEditorReducer(programEditorReducer(initialProgramEditorState, { type: "load", draft: draft() }), { type: "discard" });
    expect(state).toEqual(initialProgramEditorState);
  });
});
