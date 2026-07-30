"use client";

import { useState } from "react";
import Link from "next/link";
import { Archive, Loader2, NotebookTabs, Pencil } from "lucide-react";
import {
  archiveContextualNoteAction,
  editContextualNoteAction,
  listContextualNotesAction,
} from "@/app/actions/contextual-notes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { StateNotice } from "@/components/ui/state-notice";
import { Textarea } from "@/components/ui/textarea";
import { createClientUuid } from "@/lib/client-uuid";

type SavedNotePage = Awaited<ReturnType<typeof listContextualNotesAction>>;
type SavedNote = SavedNotePage["notes"][number];
type SavedNoteCursor = SavedNotePage["nextCursor"];

function attachmentLabel(note: SavedNote) {
  const labels: Record<SavedNote["attachmentKind"], string> = {
    general: "General training",
    workout: "Workout",
    exercise: "Workout exercise",
    occurrence: "Workout item",
    set: "Performed set",
    rest: "Rest period",
    program: "Program",
    program_day: "Program day",
    program_item: "Program item",
  };
  return labels[note.attachmentKind];
}

export function ContextualNoteManager() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<SavedNote[]>([]);
  const [nextCursor, setNextCursor] = useState<SavedNoteCursor>(null);
  const [editing, setEditing] = useState<SavedNote | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editCoachVisible, setEditCoachVisible] = useState(true);
  const [issue, setIssue] = useState<string | null>(null);
  const [archiveOperationId, setArchiveOperationId] = useState<string | null>(null);

  async function loadNotes(cursor: SavedNoteCursor = null) {
    setLoading(true);
    setIssue(null);
    try {
      const page = await listContextualNotesAction(cursor);
      setNotes((current) => cursor ? [...current, ...page.notes] : page.notes);
      setNextCursor(page.nextCursor);
    } catch {
      setIssue("Saved notes could not be loaded. Nothing was changed.");
    } finally {
      setLoading(false);
    }
  }

  function beginEdit(note: SavedNote) {
    setEditing(note);
    setEditBody(note.body);
    setEditCoachVisible(note.coachVisible);
    setIssue(null);
  }

  async function saveEdit() {
    if (!editing) return;
    setLoading(true);
    setIssue(null);
    let result: Awaited<ReturnType<typeof editContextualNoteAction>>;
    try {
      result = await editContextualNoteAction({
        noteId: editing.id,
        clientKey: createClientUuid(),
        expectedRevision: editing.revision,
        body: editBody,
        coachVisible: editCoachVisible,
        inputMode: "typed",
      });
    } catch {
      setLoading(false);
      setIssue("The server did not acknowledge this edit. The saved note is unchanged.");
      return;
    }
    setLoading(false);
    if (!result.ok) {
      setIssue(result.reason);
      return;
    }
    setNotes((current) =>
      current.map((note) =>
        note.id === result.note.id
          ? {
              ...note,
              body: result.note.body,
              coachVisible: result.note.coachVisible,
              inputMode: result.note.inputMode,
              revision: result.note.revision,
            }
          : note,
      ),
    );
    setEditing(null);
  }

  async function archiveNote(note: SavedNote) {
    if (!window.confirm("Archive this note? Its revisions remain recoverable through Archive and Undo.")) {
      return;
    }
    setLoading(true);
    setIssue(null);
    let result: Awaited<ReturnType<typeof archiveContextualNoteAction>>;
    try {
      result = await archiveContextualNoteAction({
        noteId: note.id,
        expectedRevision: note.revision,
      });
    } catch {
      setLoading(false);
      setIssue("The server did not acknowledge this archive action. The note remains saved.");
      return;
    }
    setLoading(false);
    if (!result.ok) {
      setIssue(result.reason);
      return;
    }
    setNotes((current) => current.filter((candidate) => candidate.id !== note.id));
    setEditing(null);
    setArchiveOperationId(result.operationId);
  }

  return (
    <>
      <Button
        type="button"
        size="touch"
        variant="ghost"
        onClick={() => {
          setOpen(true);
          setEditing(null);
          setArchiveOperationId(null);
          void loadNotes(null);
        }}
      >
        <NotebookTabs aria-hidden="true" /> Review notes
      </Button>
      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerContent className="[--drawer-content-max-height:calc(100dvh-1rem)] [&_button]:min-h-11 [&_textarea]:min-h-24">
          <DrawerHeader>
            <DrawerTitle>Review saved training notes</DrawerTitle>
            <DrawerDescription>
              Correct your text or privacy choice with a new revision. Archive keeps the full record available for Undo.
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {issue && <StateNotice state="needs_attention" title="Nothing was changed" description={issue} />}
            {archiveOperationId && (
              <StateNotice
                state="saved"
                title="Note archived"
                description="The note and its revision history are retained."
                action={(
                  <Button
                    variant="outline"
                    size="sm"
                    render={<Link href={`/archive#operation-${archiveOperationId}`} />}
                    nativeButton={false}
                    onClick={() => setOpen(false)}
                  >
                    Review or undo
                  </Button>
                )}
              />
            )}
            {editing ? (
              <div className="space-y-4 rounded-xl border p-3">
                <p className="text-sm font-medium">Edit {attachmentLabel(editing)} note</p>
                <label className="block text-sm font-medium">
                  Your observation
                  <Textarea
                    className="mt-1"
                    value={editBody}
                    maxLength={5_000}
                    rows={5}
                    onChange={(event) => setEditBody(event.target.value)}
                  />
                </label>
                <label className="flex min-h-11 items-center gap-3 rounded-xl border p-3 text-sm">
                  <Checkbox
                    checked={editCoachVisible}
                    onCheckedChange={(checked) => setEditCoachVisible(checked === true)}
                  />
                  <span>
                    <span className="block font-medium">Visible to Coach and Review</span>
                    <span className="block text-muted-foreground">Turn off to keep this revision private from AI context.</span>
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void saveEdit()} disabled={loading || editBody.trim().length < 1}>
                    {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                    Save revision
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={loading}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading saved notes…
              </p>
            ) : notes.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No active saved notes.</p>
            ) : (
              <ol className="space-y-2">
                {notes.map((note) => (
                  <li key={note.id} className="rounded-xl border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{attachmentLabel(note)}</span>
                      <span className="text-xs text-muted-foreground">
                        {note.coachVisible ? "Coach-visible" : "Private"} · revision {note.revision}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap leading-6">{note.body}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => beginEdit(note)}>
                        <Pencil aria-hidden="true" /> Edit text or privacy
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => void archiveNote(note)}>
                        <Archive aria-hidden="true" /> Archive
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {!editing && !loading && nextCursor && (
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="w-full"
                onClick={() => void loadNotes(nextCursor)}
              >
                Load older notes
              </Button>
            )}
          </div>
          <DrawerFooter>
            <Button type="button" variant="outline" size="touch" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
