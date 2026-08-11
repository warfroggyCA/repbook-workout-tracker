import { afterEach, describe, expect, it } from "vitest";
import { isProgramTextImportEnabled } from "@/lib/program-text-import-feature";

const original = process.env.PROGRAM_TEXT_IMPORT_ENABLED;

afterEach(() => {
  if (original == null) delete process.env.PROGRAM_TEXT_IMPORT_ENABLED;
  else process.env.PROGRAM_TEXT_IMPORT_ENABLED = original;
});

describe("Program text import release switch", () => {
  it("keeps imports on by default and disables only on an exact false value", () => {
    delete process.env.PROGRAM_TEXT_IMPORT_ENABLED;
    expect(isProgramTextImportEnabled()).toBe(true);
    process.env.PROGRAM_TEXT_IMPORT_ENABLED = "FALSE";
    expect(isProgramTextImportEnabled()).toBe(true);
    process.env.PROGRAM_TEXT_IMPORT_ENABLED = "false";
    expect(isProgramTextImportEnabled()).toBe(false);
  });
});
