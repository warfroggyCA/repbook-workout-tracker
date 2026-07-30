import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("contextual note management interaction", () => {
  const manager = readFileSync(
    "src/components/contextual-notes/contextual-note-manager.tsx",
    "utf8",
  );
  const actions = readFileSync("src/app/actions/contextual-notes.ts", "utf8");

  it("keeps review, privacy editing, archive, and Undo reachable", () => {
    expect(manager).toContain("Review notes");
    expect(manager).toContain("Edit text or privacy");
    expect(manager).toContain("Visible to Coach and Review");
    expect(manager).toContain("Archive");
    expect(manager).toContain("Review or undo");
    expect(manager).toContain("/archive#operation-${archiveOperationId}");
    expect(manager).toContain("Load older notes");
    expect(manager).toContain("loadNotes(nextCursor)");
    expect(actions).toContain("CONTEXTUAL_NOTE_MANAGER_PAGE_SIZE");
    expect(actions).toContain("nextCursor:");
  });

  it("sends the displayed revision through both guarded mutations", () => {
    expect(manager).toMatch(/editContextualNoteAction\([\s\S]*expectedRevision: editing\.revision/);
    expect(manager).toMatch(/archiveContextualNoteAction\([\s\S]*expectedRevision: note\.revision/);
    expect(manager).toContain('inputMode: "typed"');
    expect(actions).toContain("editContextualNote(db, user.id, parsed.data)");
    expect(actions).toContain("archiveContextualNote(db, user.id, parsed.data)");
    expect(actions).toContain("This note changed elsewhere");
  });
});
