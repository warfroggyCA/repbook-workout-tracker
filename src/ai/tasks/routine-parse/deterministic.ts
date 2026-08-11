import type { RoutineParseResult } from "@/ai/tasks/routine-parse/schema";
import { routineParseSchema } from "@/ai/tasks/routine-parse/schema";

const PROGRAM_HEADING = /^Program\s*:\s*(.+)$/iu;
const DAY_HEADING = /^Day\s+\d+\b(?:\s*[\u2013\u2014-]\s*.+)?$/iu;
const EXERCISE_LINE =
  /^(?:(?<group>[A-Za-z])(?<member>\d+)\s+)?(?<name>.+?)\s+(?<sets>\d{1,2})\s*[x\u00d7]\s*(?<repMin>\d{1,3})(?:\s*[\u2013\u2014-]\s*(?<repMax>\d{1,3}))?(?<tail>.*)$/u;
const EXERCISE_TAIL =
  /^\s*(?:@\s*(?<load>\d+(?:\.\d+)?)\s*(?<loadUnit>lb|kg))?\s*(?:,\s*)?(?:rest\s+(?<rest>\d+(?:\.\d+)?)\s*(?<restUnit>sec(?:ond)?s?|s|min(?:ute)?s?|m))?\s*$/iu;

export const CANONICAL_ROUTINE_PARSER_VERSION = "canonical-routine-text/1";

export type RoutineTextStructure = Readonly<{
  characterCount: number;
  dayCount: number;
  exerciseCount: number;
}>;

export function collectSupersetRoundRestSeconds(
  exercises: ReadonlyArray<{
    supersetKey: string | null;
    restSec: number | null;
  }>,
) {
  const restByGroup = new Map<string, number>();
  for (const exercise of exercises) {
    if (exercise.supersetKey && exercise.restSec !== null) {
      // Canonical A1/A2 notation applies the final member's rest after a round.
      restByGroup.set(exercise.supersetKey, exercise.restSec);
    }
  }
  return restByGroup;
}

export function inspectRoutineTextStructure(input: string): RoutineTextStructure {
  const lines = input.split(/\r?\n/u).map((line) => line.trim());
  return {
    characterCount: input.length,
    dayCount: lines.filter((line) => DAY_HEADING.test(line)).length,
    exerciseCount: lines.filter((line) => EXERCISE_LINE.test(line)).length,
  };
}

function restSeconds(value: string, unit: string) {
  const amount = Number(value);
  const seconds = /^(?:m|min)/iu.test(unit) ? amount * 60 : amount;
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 1_800
    ? seconds
    : null;
}

/**
 * Parses Repbook's documented canonical paste format without an AI call.
 * It succeeds only when every non-heading line is understood; otherwise the
 * caller can use the provider-backed parser without silently dropping text.
 */
export function parseCanonicalRoutineText(
  input: string,
): RoutineParseResult | null {
  const lines = input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  let programName: string | null = null;
  const days: RoutineParseResult["data"]["days"] = [];

  for (const line of lines) {
    const program = PROGRAM_HEADING.exec(line);
    if (program) {
      if (programName !== null || days.length > 0) return null;
      programName = program[1]?.trim() || null;
      if (!programName) return null;
      continue;
    }

    if (DAY_HEADING.test(line)) {
      if (days.at(-1)?.exercises.length === 0) return null;
      days.push({ name: line, order: days.length, exercises: [] });
      continue;
    }

    const currentDay = days.at(-1);
    if (!currentDay) return null;
    const exercise = EXERCISE_LINE.exec(line);
    if (!exercise?.groups) return null;

    const name = exercise.groups.name?.trim();
    const sets = Number(exercise.groups.sets);
    const repMin = Number(exercise.groups.repMin);
    const repMax = Number(exercise.groups.repMax ?? exercise.groups.repMin);
    if (
      !name ||
      !Number.isSafeInteger(sets) ||
      sets < 1 ||
      sets > 20 ||
      !Number.isSafeInteger(repMin) ||
      !Number.isSafeInteger(repMax) ||
      repMin < 1 ||
      repMax < repMin ||
      repMax > 100
    ) {
      return null;
    }

    const tail = EXERCISE_TAIL.exec(exercise.groups.tail ?? "");
    if (!tail?.groups) return null;
    const load = tail.groups.load == null ? null : Number(tail.groups.load);
    const loadUnit = tail.groups.loadUnit?.toLowerCase() as "kg" | "lb" | undefined;
    const restSec =
      tail.groups.rest == null || tail.groups.restUnit == null
        ? null
        : restSeconds(tail.groups.rest, tail.groups.restUnit);
    if (
      (load !== null && (!Number.isFinite(load) || load < 0 || !loadUnit)) ||
      (tail.groups.rest != null && restSec === null)
    ) {
      return null;
    }

    currentDay.exercises.push({
      rawName: name,
      sets,
      reps: { kind: "range", min: repMin, max: repMax },
      load,
      loadUnit: loadUnit ?? null,
      restSec,
      supersetKey: exercise.groups.group?.toUpperCase() ?? null,
      notes: null,
    });
  }

  if (days.length === 0 || days.some((day) => day.exercises.length === 0)) {
    return null;
  }
  for (const day of days) {
    const groupCounts = new Map<string, number>();
    for (const exercise of day.exercises) {
      if (exercise.supersetKey) {
        groupCounts.set(
          exercise.supersetKey,
          (groupCounts.get(exercise.supersetKey) ?? 0) + 1,
        );
      }
    }
    if ([...groupCounts.values()].some((count) => count < 2)) return null;
  }

  return routineParseSchema.parse({
    data: { programName, days },
    confidence: 1,
    ambiguities: [],
    clarifyingQuestions: [],
    unparsed: [],
  });
}
