/**
 * Deterministic fast path for clean quick-log lines (plan §8/§13): patterns
 * like "Bench 135x8,8,7" or "Goblet squat 35 for 12, 12, 10" parse without an
 * AI call. Anything that doesn't fully match returns null and falls through
 * to the AI parser (or manual entry when AI is unavailable).
 */
import type { LogEntry } from "@/ai/tasks/log-parse/schema";
import type { LoadUnit } from "@/lib/units";

const CLEAN_LINE =
  /^\s*(?<name>[a-z][a-z\s\-']*?)\s+(?<weight>\d+(?:\.\d+)?)\s*(?<unit>lbs?|kg)?\s*(?:x|for\s+)\s*(?<reps>\d+(?:\s*[,x]\s*\d+)*)\s*$/i;

const BODYWEIGHT_LINE =
  /^\s*(?<name>[a-z][a-z\s\-']*?)\s+(?:x\s*)?(?<reps>\d+(?:\s*,\s*\d+)+)\s*$/i;

export function parseCleanLogLine(
  line: string,
  defaultUnit: LoadUnit = "lb"
): LogEntry | null {
  const weighted = CLEAN_LINE.exec(line);
  if (weighted?.groups) {
    const reps = weighted.groups.reps
      .split(/[,x]/)
      .map((r) => Number(r.trim()))
      .filter((n) => Number.isFinite(n));
    if (!reps.length || reps.some((r) => r > 100)) return null;
    const weightUnit = weighted.groups.unit?.toLowerCase().startsWith("kg")
      ? "kg"
      : weighted.groups.unit
        ? "lb"
        : defaultUnit;
    return {
      kind: "sets",
      rawExercise: weighted.groups.name.trim(),
      sets: reps.map((r) => ({
        weight: Number(weighted.groups!.weight),
        weightUnit,
        reps: r,
        rpeHint: null,
      })),
    };
  }

  const bodyweight = BODYWEIGHT_LINE.exec(line);
  if (bodyweight?.groups) {
    const reps = bodyweight.groups.reps
      .split(",")
      .map((r) => Number(r.trim()))
      .filter((n) => Number.isFinite(n));
    if (!reps.length || reps.some((r) => r > 100)) return null;
    return {
      kind: "sets",
      rawExercise: bodyweight.groups.name.trim(),
      sets: reps.map((r) => ({
        weight: null,
        weightUnit: null,
        reps: r,
        rpeHint: null,
      })),
    };
  }

  return null;
}

/**
 * Whole input parses deterministically only when EVERY non-empty line is a
 * clean set line. One messy line → the whole input goes to the AI parser so
 * context isn't split.
 */
export function parseCleanLog(
  input: string,
  defaultUnit: LoadUnit = "lb"
): LogEntry[] | null {
  const lines = input
    .split(/\n|\.\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const entries: LogEntry[] = [];
  for (const line of lines) {
    const entry = parseCleanLogLine(line, defaultUnit);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
}
