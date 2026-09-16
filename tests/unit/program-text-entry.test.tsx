import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgramTextEntry } from "@/components/import/program-text-entry";
vi.mock("@/components/program/program-editor", () => ({
  ProgramEditor: () => <div>Local Program editor</div>,
}));
vi.mock("@/components/import/routine-import", () => ({
  RoutineImport: () => <div>Complete routine importer</div>,
}));
describe("the Program paste entry point", () => {
  it("defaults an existing Program to local editing", () => {
    const html = renderToStaticMarkup(
      <ProgramTextEntry
        ownerId="synthetic"
        library={[]}
        canUpdate
        aiAvailable={false}
      />,
    );
    expect(html).toContain("Local Program editor");
    expect(html).toContain("Import a complete routine instead");
    expect(html).not.toContain("Complete routine importer");
  });
  it.each([false, true])(
    "retains explicit new routine import when editing availability is %s",
    (canUpdate) => {
      const html = renderToStaticMarkup(
        <ProgramTextEntry
          ownerId="synthetic"
          library={[]}
          canUpdate={canUpdate}
          aiAvailable={false}
          initialDestination="create_new_active"
        />,
      );
      expect(html).toContain("Complete routine importer");
      expect(html).not.toContain("Local Program editor");
    },
  );
  it("retains import when there is no editable Program", () => {
    expect(
      renderToStaticMarkup(
        <ProgramTextEntry
          ownerId="synthetic"
          library={[]}
          canUpdate={false}
          aiAvailable={false}
        />,
      ),
    ).toContain("Complete routine importer");
  });
});
