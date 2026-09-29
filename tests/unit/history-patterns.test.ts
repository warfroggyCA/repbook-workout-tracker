import {
  historyReturnContext,
  buildHistoryHref,
} from "@/lib/history-navigation";
import { describe, expect, it } from "vitest";
import {
  buildHistoryPatterns,
  type HistoryPatternRow,
} from "@/lib/history-patterns";
const rows: HistoryPatternRow[] = [1, 2, 3, 4].map((i) => ({
  sessionId: `s${i}`,
  localDate: `2026-09-0${i}`,
  workoutName: "Leg day",
  slotId: "slot",
  exerciseId: "calves",
  exerciseName: "Calf raises",
  skipped: i !== 2,
}));
describe("repeated History observations", () => {
  it("names a repeated pattern and preserves exact supporting workouts", () => {
    const [pattern] = buildHistoryPatterns(rows);
    expect(pattern.skipped).toBe(3);
    expect(pattern.workouts.map((row) => row.sessionId)).toEqual([
      "s4",
      "s3",
      "s2",
      "s1",
    ]);
  });
  it("does not warn for a single skip or inflate repeated occurrence rows", () => {
    expect(buildHistoryPatterns([rows[0], rows[0], rows[0]])).toEqual([]);
    expect(
      buildHistoryPatterns(
        rows.map((row, i) => ({ ...row, skipped: i === 0 })),
      ),
    ).toEqual([]);
  });
  it("does not merge names, different identities or different Program slots", () => {
    expect(
      buildHistoryPatterns(
        rows.map((row, i) => ({ ...row, exerciseId: `variant${i}` })),
      ),
    ).toEqual([]);
    expect(
      buildHistoryPatterns(
        rows.map((row, i) => ({ ...row, slotId: `slot${i}` })),
      ),
    ).toEqual([]);
  });
  it("uses only the latest four workouts, allowing a pattern to disappear", () => {
    expect(
      buildHistoryPatterns([
        ...rows,
        ...rows.map((row, i) => ({
          ...row,
          sessionId: `new${i}`,
          localDate: `2026-09-1${i}`,
          skipped: false,
        })),
      ]),
    ).toEqual([]);
  });
});

it("preserves calendar context without accepting external return links", () => {
  expect(
    buildHistoryHref(
      historyReturnContext(
        "/history?range=all&calendarView=year&calendarDate=2026-08-01",
      ),
    ),
  ).toContain("calendarDate=2026-08-01");
  expect(buildHistoryHref(historyReturnContext("https://example.com"))).toBe(
    "/history?range=12w",
  );
});
