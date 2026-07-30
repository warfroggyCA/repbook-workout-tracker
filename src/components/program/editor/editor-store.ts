import { createContext, useContext } from "react";
import type { Dispatch } from "react";
import type {
  ProgramReview,
  ServerDraft,
} from "@/lib/program-editor-client";
import type { ProgramDocumentV3 } from "@/lib/program-document";

export type ProgramEditorSaveStatus =
  | "loading"
  | "saved"
  | "local"
  | "saving"
  | "queued"
  | "conflict"
  | "attention"
  | "failed"
  | "published";

export type ProgramEditorState = {
  draft: ServerDraft | null;
  document: ProgramDocumentV3 | null;
  revision: number;
  pendingMutationId: string | null;
  dirty: boolean;
  review: ProgramReview | null;
  status: ProgramEditorSaveStatus;
  message: string | null;
  conflictDraft: ServerDraft | null;
};

export const initialProgramEditorState: ProgramEditorState = {
  draft: null,
  document: null,
  revision: 0,
  pendingMutationId: null,
  dirty: false,
  review: null,
  status: "loading",
  message: null,
  conflictDraft: null,
};

export type ProgramEditorAction =
  | { type: "load"; draft: ServerDraft }
  | {
      type: "edit";
      document: ProgramDocumentV3;
      mutationId: string;
      recoverable: boolean;
      message?: string | null;
    }
  | { type: "autosave-start" }
  | { type: "autosave-success"; revision: number; mutationId: string }
  | { type: "server-conflict"; draft: ServerDraft; message?: string | null }
  | {
      type: "local-recovery";
      draft: ServerDraft;
      document: ProgramDocumentV3;
      mutationId: string;
      offline: boolean;
    }
  | { type: "publish-handoff"; versionNo: number }
  | { type: "discard" }
  | { type: "review"; review: ProgramReview | null }
  | { type: "status"; status: ProgramEditorSaveStatus; message?: string | null }
  | { type: "clear-conflict" };

export function programEditorReducer(
  state: ProgramEditorState,
  action: ProgramEditorAction,
): ProgramEditorState {
  switch (action.type) {
    case "load":
      return {
        ...state,
        draft: action.draft,
        document: action.draft.document,
        revision: action.draft.revision,
        pendingMutationId: null,
        dirty: false,
        review: action.draft.reviewSummary,
        status: "saved",
        message: null,
        conflictDraft: null,
      };
    case "edit":
      return {
        ...state,
        document: action.document,
        pendingMutationId: action.mutationId,
        dirty: true,
        review: null,
        status: action.recoverable ? "local" : "failed",
        message: action.message ?? null,
      };
    case "autosave-start":
      return { ...state, status: "saving", message: null };
    case "autosave-success": {
      const stillCurrent = state.pendingMutationId === action.mutationId;
      return {
        ...state,
        revision: action.revision,
        pendingMutationId: stillCurrent ? null : state.pendingMutationId,
        dirty: stillCurrent ? false : state.dirty,
        status: stillCurrent ? "saved" : state.status,
      };
    }
    case "server-conflict":
      return {
        ...state,
        conflictDraft: action.draft,
        status: "conflict",
        message:
          action.message ??
          "Another tab saved a newer draft. Choose which copy to continue from.",
      };
    case "local-recovery":
      return {
        ...state,
        draft: action.draft,
        document: action.document,
        revision: action.draft.revision,
        pendingMutationId: action.mutationId,
        dirty: true,
        review: null,
        status: action.offline ? "queued" : "local",
        message: action.offline
          ? "Recovered this browser's unsent draft while offline. It will retry when connected."
          : "Recovered this browser's unsent draft. Reconnecting it to the server…",
      };
    case "publish-handoff":
      return {
        ...state,
        pendingMutationId: null,
        dirty: false,
        review: null,
        status: "published",
        message: `Version ${action.versionNo || "created"} is now current.`,
        conflictDraft: null,
      };
    case "discard":
      return { ...initialProgramEditorState };
    case "review":
      return { ...state, review: action.review };
    case "status":
      return {
        ...state,
        status: action.status,
        message: action.message === undefined ? state.message : action.message,
      };
    case "clear-conflict":
      return { ...state, conflictDraft: null };
  }
}

export type ProgramEditorDocumentContextValue = Pick<
  ProgramEditorState,
  "draft" | "document" | "revision" | "pendingMutationId" | "dirty" | "review"
>;

export type ProgramEditorStatusContextValue = Pick<
  ProgramEditorState,
  "status" | "message" | "conflictDraft"
>;

export const ProgramEditorDocumentContext =
  createContext<ProgramEditorDocumentContextValue | null>(null);
export const ProgramEditorStatusContext =
  createContext<ProgramEditorStatusContextValue | null>(null);
export const ProgramEditorDispatchContext =
  createContext<Dispatch<ProgramEditorAction> | null>(null);

export function useProgramEditorDocument() {
  const value = useContext(ProgramEditorDocumentContext);
  if (!value) throw new Error("ProgramEditorDocumentContext is missing.");
  return value;
}

export function useProgramEditorStatus() {
  const value = useContext(ProgramEditorStatusContext);
  if (!value) throw new Error("ProgramEditorStatusContext is missing.");
  return value;
}

export function useProgramEditorDispatch() {
  const value = useContext(ProgramEditorDispatchContext);
  if (!value) throw new Error("ProgramEditorDispatchContext is missing.");
  return value;
}
