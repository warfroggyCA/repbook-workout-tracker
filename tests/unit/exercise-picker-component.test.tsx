import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ExercisePicker hierarchy", () => {
  it("keeps families at the root level and nests their variants one level deeper", () => {
    const source = readFileSync(
      "src/components/exercises/exercise-picker.tsx",
      "utf8",
    );

    expect(source).toContain('aria-label="Exercise results"');
    expect(source).toMatch(
      /<section[\s\S]*?role="listitem"[\s\S]*?<button[\s\S]*?<ExerciseFamilyIcon[\s\S]*?\{isExpanded \? \([\s\S]*?<ChevronDown/,
    );
    expect(source).toMatch(
      /className="ml-4 divide-y border-l border-t"[\s\S]*?role="list"[\s\S]*?aria-label=\{`\$\{family\.name\} variants`\}/,
    );
    expect(source).toMatch(
      /role="list"[\s\S]*?family\.variants\.map[\s\S]*?role="listitem"[\s\S]*?<ExerciseVariantButton/,
    );
  });
});
