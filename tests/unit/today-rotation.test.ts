import { describe, it, expect } from "vitest";
import { pickNextTemplateId } from "@/services/today";

const [A, B, C] = ["tpl-a", "tpl-b", "tpl-c"];
const templates = [A, B, C];

describe("pickNextTemplateId (rotation rule)", () => {
  it("cycles to the template after the last completed one", () => {
    expect(pickNextTemplateId(templates, [A])).toBe(B);
    expect(pickNextTemplateId(templates, [B, A])).toBe(C);
    expect(pickNextTemplateId(templates, [C, B, A])).toBe(A); // wraps
  });

  it("starts at the first template with no history", () => {
    expect(pickNextTemplateId(templates, [])).toBe(A);
  });

  // Regression: quick logs are template-less completed sessions and must not
  // reset the rotation back to Day A.
  it("skips template-less sessions (quick logs) when picking the rotation", () => {
    expect(pickNextTemplateId(templates, [null, A])).toBe(B);
    expect(pickNextTemplateId(templates, [null, null, B, A])).toBe(C);
  });

  it("falls back to the first template when history is all quick logs", () => {
    expect(pickNextTemplateId(templates, [null, null])).toBe(A);
  });

  it("falls back to the first template when the last template left the program", () => {
    // e.g. routine import archived the old program's templates
    expect(pickNextTemplateId(templates, ["tpl-old-program"])).toBe(A);
  });

  it("keeps a single-day Program on its only day", () => {
    expect(pickNextTemplateId([A], [A])).toBe(A);
  });
});
