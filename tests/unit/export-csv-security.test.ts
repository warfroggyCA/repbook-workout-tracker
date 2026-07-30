import { describe, expect, it } from "vitest";
import { toCsv } from "@/services/export";

describe("CSV export safety", () => {
  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1:A2)", "\t=1+1", "\r=1+1"])(
    "forces a spreadsheet-dangerous value to remain text: %j",
    (value) => {
      expect(toCsv(["value"], [[value]])).toBe(`value\n'${value}`);
    }
  );

  it("applies formula protection before normal CSV quoting", () => {
    expect(toCsv(["value"], [['=HYPERLINK("https://example.test")']])).toBe(
      'value\n"\'=HYPERLINK(""https://example.test"")"'
    );
  });

  it("does not alter ordinary exported values", () => {
    expect(toCsv(["name", "note"], [["Squat", "heavy, controlled"]])).toBe(
      'name,note\nSquat,"heavy, controlled"'
    );
  });
});
