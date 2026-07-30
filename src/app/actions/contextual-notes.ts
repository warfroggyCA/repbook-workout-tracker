"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  contextualNoteCreateInputSchema,
  contextualNoteEditInputSchema,
  type ContextualNoteCreateInput,
  type ContextualNoteEditInput,
} from "@/lib/contextual-note-contract";
import { hashContextualNotePayload } from "@/lib/contextual-note-outbox";
import { getCurrentUser } from "@/lib/user";
import { logServerEvent } from "@/lib/server-log";
import {
  archiveContextualNote,
  createContextualNote,
  editContextualNote,
  listContextualNotes,
  type ContextualNoteRecord,
} from "@/services/contextual-notes";
import { z } from "zod";

export type CreateContextualNoteActionResult =
  | {
      ok: true;
      clientKey: string;
      payloadHash: string;
      noteId: string;
      outcome: "saved" | "replayed";
    }
  | { ok: false; reason: string; retryable: boolean };

function revalidateContextualNoteDestinations(input: ContextualNoteCreateInput) {
  revalidatePath("/history");
  revalidatePath("/coach");
  revalidatePath("/export");
  revalidatePath("/recovery");
  revalidatePath("/archive");
  if ("sessionId" in input) {
    revalidatePath(`/session/${input.sessionId}`);
    revalidatePath(`/history/${input.sessionId}`);
  }
  if ("programId" in input) revalidatePath("/program");
}

function revalidateAllContextualNoteDestinations(note?: ContextualNoteRecord) {
  for (const path of ["/history", "/coach", "/program", "/export", "/recovery", "/archive"]) {
    revalidatePath(path);
  }
  if (note?.sessionId) {
    revalidatePath(`/session/${note.sessionId}`);
    revalidatePath(`/history/${note.sessionId}`);
  }
}

export async function createContextualNoteAction(
  rawInput: ContextualNoteCreateInput,
): Promise<CreateContextualNoteActionResult> {
  const parsed = contextualNoteCreateInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "This note is incomplete or no longer matches its captured context.",
      retryable: false,
    };
  }

  try {
    const user = await getCurrentUser();
    const db = await getDb();
    const result = await createContextualNote(db, user.id, parsed.data);
    if (result.outcome === "not_found") {
      return {
        ok: false,
        reason: "The item this note describes is no longer available.",
        retryable: false,
      };
    }
    if (result.outcome !== "saved" && result.outcome !== "replayed") {
      return {
        ok: false,
        reason: "This device note identity is already associated with different text.",
        retryable: false,
      };
    }
    revalidateContextualNoteDestinations(parsed.data);
    return {
      ok: true,
      clientKey: parsed.data.clientKey,
      payloadHash: hashContextualNotePayload(parsed.data),
      noteId: result.note.id,
      outcome: result.outcome,
    };
  } catch (error) {
    logServerEvent("error", "contextual_note.save_failed", {
      attachmentKind: parsed.data.attachmentKind,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return {
      ok: false,
      reason: "The server did not acknowledge this note. It remains on this device.",
      retryable: true,
    };
  }
}

const contextualNoteListCursorSchema = z.object({
  recordedAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
}).strict();

const CONTEXTUAL_NOTE_MANAGER_PAGE_SIZE = 50;

export async function listContextualNotesAction(rawCursor?: {
  recordedAt: string;
  id: string;
} | null) {
  const parsedCursor = rawCursor == null
    ? null
    : contextualNoteListCursorSchema.parse(rawCursor);
  const user = await getCurrentUser();
  const db = await getDb();
  const notes = await listContextualNotes(db, user.id, {
    limit: CONTEXTUAL_NOTE_MANAGER_PAGE_SIZE + 1,
    before: parsedCursor ?? undefined,
  });
  const page = notes.slice(0, CONTEXTUAL_NOTE_MANAGER_PAGE_SIZE);
  const mapped = page.map((note) => ({
    id: note.id,
    body: note.body,
    coachVisible: note.coachVisible,
    inputMode: note.inputMode,
    attachmentKind: note.attachmentKind,
    revision: note.revision,
    recordedAt: note.recordedAt,
    sessionId: note.sessionId,
    programId: note.programId,
  }));
  const last = page.at(-1);
  return {
    notes: mapped,
    nextCursor: notes.length > CONTEXTUAL_NOTE_MANAGER_PAGE_SIZE && last
      ? { recordedAt: last.recordedAt, id: last.id }
      : null,
  };
}

export async function editContextualNoteAction(rawInput: ContextualNoteEditInput) {
  const parsed = contextualNoteEditInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false as const, reason: "Review the note text and try again." };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  try {
    const result = await editContextualNote(db, user.id, parsed.data);
    if (result.outcome === "stale") {
      return {
        ok: false as const,
        reason: "This note changed elsewhere. Reload the saved notes before editing it again.",
      };
    }
    if (result.outcome === "not_found") {
      return { ok: false as const, reason: "This note is no longer available." };
    }
    if (result.outcome === "conflict") {
      return {
        ok: false as const,
        reason: "That edit identity is already associated with different content.",
      };
    }
    revalidateAllContextualNoteDestinations(result.note);
    return { ok: true as const, note: result.note };
  } catch (error) {
    logServerEvent("error", "contextual_note.edit_failed", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return { ok: false as const, reason: "The server did not acknowledge this edit." };
  }
}

const contextualNoteArchiveInputSchema = z.object({
  noteId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
}).strict();

export async function archiveContextualNoteAction(rawInput: {
  noteId: string;
  expectedRevision: number;
}) {
  const parsed = contextualNoteArchiveInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false as const, reason: "This archive request is incomplete." };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  try {
    const result = await archiveContextualNote(db, user.id, parsed.data);
    if (result.outcome === "stale") {
      return {
        ok: false as const,
        reason: "This note changed elsewhere. Reload the saved notes before archiving it.",
      };
    }
    if (result.outcome === "not_found") {
      return { ok: false as const, reason: "This note is no longer available." };
    }
    revalidateAllContextualNoteDestinations();
    return { ok: true as const, operationId: result.operationId };
  } catch (error) {
    logServerEvent("error", "contextual_note.archive_failed", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return { ok: false as const, reason: "The server did not acknowledge this archive action." };
  }
}
