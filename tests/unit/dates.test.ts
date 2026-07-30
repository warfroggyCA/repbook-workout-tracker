import { describe, expect, it } from "vitest";
import { formatRelativeDay, formatRelativeLocalDate } from "@/lib/dates";

describe("formatRelativeDay", () => {
  it("uses the profile timezone across a UTC date boundary", () => {
    const now = new Date("2026-07-14T00:30:00.000Z");
    const recorded = new Date("2026-07-13T22:30:00.000Z");

    expect(formatRelativeDay(recorded, "America/Toronto", now)).toBe("today");
    expect(formatRelativeDay(recorded, "Europe/London", now)).toBe("yesterday");
  });

  it("uses the intended 0, 1, 6, and 7 day relative-date boundaries", () => {
    expect(formatRelativeLocalDate("2026-07-18", "2026-07-18")).toBe("today");
    expect(formatRelativeLocalDate("2026-07-17", "2026-07-18")).toBe("yesterday");
    expect(formatRelativeLocalDate("2026-07-12", "2026-07-18")).toBe("6 days ago");
    expect(formatRelativeLocalDate("2026-07-11", "2026-07-18")).not.toContain("days ago");
  });
});
