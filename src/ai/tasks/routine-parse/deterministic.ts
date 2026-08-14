import { normalizeRoutineParseDraftEnvelope } from "@/ai/tasks/routine-parse/normalize";
import {
  routineParseDraftSchema,
  type RoutineParseDraftData,
  type RoutineParseDraftWarmupItem,
  type RoutineParseResult,
} from "@/ai/tasks/routine-parse/schema";

const PROGRAM_HEADING = /^Program\s*:\s*(.+)$/iu;
const DAY_HEADING = /^Day\s+\d+\b(?:\s*[\u2013\u2014-]\s*.+)?$/iu;
const DAY_WARMUP_LINE = /^Warm[ -]?up\s*:\s*(.+)$/iu;
const EXERCISE_RAMP_LINE = /^Ramp[ -]?up\s*:\s*(.+)$/iu;
const EXERCISE_NOTES_LINE = /^Exercise notes?\s*:\s*(.+)$/iu;
const EXERCISE_LINE =
  /^(?:(?<group>[A-Za-z])(?<member>\d+)\s+)?(?<name>.+?)\s+(?<sets>\d{1,2})\s*[x\u00d7]\s*(?<repMin>\d{1,3})(?:\s*[\u2013\u2014-]\s*(?<repMax>\d{1,3}))?(?<tail>.*)$/u;
const EXERCISE_TAIL =
  /^\s*(?:@\s*(?<load>\d+(?:\.\d+)?)\s*(?<loadUnit>lb|kg))?\s*(?:,\s*)?(?:rest\s+(?<rest>\d+(?:\.\d+)?)\s*(?<restUnit>sec(?:ond)?s?|s|min(?:ute)?s?|m))?\s*$/iu;
const UNKNOWN_VALUE = /^(?:\?|unknown|not stated)$/iu;

export const CANONICAL_ROUTINE_PARSER_VERSION = "canonical-routine-text/3";

export type RoutineTextStructure = Readonly<{
  characterCount: number;
  dayCount: number;
  exerciseCount: number;
}>;

type ParseAmbiguity = {
  field: string;
  issue: string;
  options: string[] | null;
};

export function collectSupersetRestTimings(
  exercises: ReadonlyArray<{
    supersetKey: string | null;
    restSec: number | null;
  }>,
) {
  const membersByGroup = new Map<
    string,
    Array<{ restSec: number | null }>
  >();
  for (const exercise of exercises) {
    if (!exercise.supersetKey) continue;
    const members = membersByGroup.get(exercise.supersetKey) ?? [];
    members.push(exercise);
    membersByGroup.set(exercise.supersetKey, members);
  }
  return new Map(
    [...membersByGroup].map(([groupKey, members]) => [
      groupKey,
      {
        // In authored A1/A2 order, a non-final member's rest happens before
        // the next member; the final member's rest happens after the round.
        betweenMembersSec: members[0]?.restSec ?? null,
        afterRoundSec: members.at(-1)?.restSec ?? null,
      },
    ]),
  );
}

export function inspectRoutineTextStructure(input: string): RoutineTextStructure {
  const lines = input.split(/\r?\n/u).map((line) => line.trim());
  return {
    characterCount: input.length,
    dayCount: lines.filter((line) => DAY_HEADING.test(line)).length,
    exerciseCount: lines.filter(
      (line) =>
        !DAY_WARMUP_LINE.test(line) &&
        !EXERCISE_RAMP_LINE.test(line) &&
        !EXERCISE_NOTES_LINE.test(line) &&
        EXERCISE_LINE.test(line),
    ).length,
  };
}

function restSeconds(value: string, unit: string) {
  const amount = Number(value);
  const seconds = /^(?:m|min)/iu.test(unit) ? amount * 60 : amount;
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 1_800
    ? seconds
    : null;
}

function parseWarmupInstruction(
  source: string,
  field: string,
  sourceOrder: number,
): { item: RoutineParseDraftWarmupItem; ambiguities: ParseAmbiguity[] } | null {
  const parts = source.split("|").map((part) => part.trim());
  const label = parts.shift();
  if (!label || label.length > 120) return null;

  const item: RoutineParseDraftWarmupItem = {
    sourceOrder,
    label,
    reps: null,
    load: null,
    loadUnit: null,
    loadPercent: null,
    loadText: null,
    notes: null,
  };
  const ambiguities: ParseAmbiguity[] = [];
  const seen = new Set<"reps" | "load" | "notes">();

  for (const part of parts) {
    const attribute = /^(reps|load|notes)\s*=\s*(.*)$/iu.exec(part);
    if (!attribute) return null;
    const key = attribute[1]?.toLocaleLowerCase("en-CA") as
      | "reps"
      | "load"
      | "notes";
    const value = attribute[2]?.trim() ?? "";
    if (seen.has(key) || value.length === 0) return null;
    seen.add(key);

    if (key === "reps") {
      if (UNKNOWN_VALUE.test(value)) {
        ambiguities.push({
          field: `${field}.reps`,
          issue: "Warm-up repetitions are explicitly unknown.",
          options: null,
        });
        continue;
      }
      const reps = Number(value);
      if (!Number.isSafeInteger(reps) || reps < 0 || reps > 1_000) return null;
      item.reps = reps;
      continue;
    }

    if (key === "notes") {
      if (value.length > 500 || UNKNOWN_VALUE.test(value)) {
        if (!UNKNOWN_VALUE.test(value)) return null;
        ambiguities.push({
          field: `${field}.notes`,
          issue: "Warm-up notes are explicitly unknown.",
          options: null,
        });
        continue;
      }
      item.notes = value;
      continue;
    }

    if (UNKNOWN_VALUE.test(value)) {
      ambiguities.push({
        field: `${field}.load`,
        issue: "Warm-up loading is explicitly unknown.",
        options: null,
      });
      continue;
    }
    const measured = /^(\d+(?:\.\d+)?)\s*(lb|kg)$/iu.exec(value);
    if (measured) {
      const load = Number(measured[1]);
      if (!Number.isFinite(load) || load < 0 || load > 100_000) return null;
      item.load = load;
      item.loadUnit = measured[2]!.toLocaleLowerCase("en-CA") as "lb" | "kg";
      continue;
    }
    const percentage =
      /^~?(\d+(?:\.\d+)?)\s*%(?:\s+(?:of\s+)?(?:the\s+)?(?:work(?:ing)?\s+)?(?:load|weight))?$/iu.exec(
        value,
      );
    if (percentage) {
      const loadPercent = Number(percentage[1]);
      if (!Number.isFinite(loadPercent) || loadPercent < 0 || loadPercent > 500) {
        return null;
      }
      item.loadPercent = loadPercent;
      continue;
    }
    if (value.length > 160) return null;
    item.loadText = value;
    if (/^\d+(?:\.\d+)?$/u.test(value)) {
      ambiguities.push({
        field: `${field}.load`,
        issue: "Warm-up load unit is not stated.",
        options: ["lb", "kg", "Keep as written"],
      });
    }
  }

  return { item, ambiguities };
}

/**
 * Parses Repbook's documented canonical paste format without an AI call.
 * `Warm-up:` creates day preparation. An adjacent `Ramp-up:` after an
 * exercise creates ordered lift-specific preparation for that exercise. An
 * adjacent `Exercise notes:` line remains attached to that exact exercise.
 * Every other non-heading line must be understood or the parser fails closed
 * so the provider-backed parser can review it without silently dropping text.
 */
export function parseCanonicalRoutineText(
  input: string,
): RoutineParseResult | null {
  const lines = input
    .split(/\r?\n/u)
    .map((line) => line.trim());
  if (!lines.some(Boolean)) return null;

  let programName: string | null = null;
  const days: RoutineParseDraftData["days"] = [];
  const ambiguities: ParseAmbiguity[] = [];
  let canAttachExerciseDetails = false;

  for (const line of lines) {
    if (!line) {
      canAttachExerciseDetails = false;
      continue;
    }

    const program = PROGRAM_HEADING.exec(line);
    if (program) {
      if (programName !== null || days.length > 0) return null;
      programName = program[1]?.trim() || null;
      if (!programName) return null;
      continue;
    }

    if (DAY_HEADING.test(line)) {
      if (days.at(-1)?.exercises.length === 0) return null;
      days.push({
        name: line,
        order: days.length,
        warmupItems: [],
        exercises: [],
      });
      canAttachExerciseDetails = false;
      continue;
    }

    const currentDay = days.at(-1);
    if (!currentDay) return null;

    const dayWarmup = DAY_WARMUP_LINE.exec(line);
    if (dayWarmup) {
      const itemIndex = currentDay.warmupItems.length;
      const sourceOrder =
        currentDay.warmupItems.length +
        currentDay.exercises.reduce(
          (count, exercise) => count + exercise.rampUps.length,
          0,
        );
      const parsed = parseWarmupInstruction(
        dayWarmup[1] ?? "",
        `days[${currentDay.order}].warmupItems[${itemIndex}]`,
        sourceOrder,
      );
      if (!parsed) return null;
      currentDay.warmupItems.push(parsed.item);
      ambiguities.push(...parsed.ambiguities);
      canAttachExerciseDetails = false;
      continue;
    }

    const exerciseNotes = EXERCISE_NOTES_LINE.exec(line);
    if (exerciseNotes) {
      const currentExercise = currentDay.exercises.at(-1);
      const notes = exerciseNotes[1]?.trim() ?? "";
      if (
        !canAttachExerciseDetails ||
        !currentExercise ||
        currentExercise.notes !== null ||
        notes.length === 0 ||
        notes.length > 2_000
      ) {
        return null;
      }
      currentExercise.notes = notes;
      continue;
    }

    const ramp = EXERCISE_RAMP_LINE.exec(line);
    if (ramp) {
      const currentExercise = currentDay.exercises.at(-1);
      if (!currentExercise) return null;
      const exerciseIndex = currentDay.exercises.length - 1;
      const setIndex = currentExercise.rampUps.length;
      const sourceOrder =
        currentDay.warmupItems.length +
        currentDay.exercises.reduce(
          (count, exercise) => count + exercise.rampUps.length,
          0,
        );
      const parsed = parseWarmupInstruction(
        ramp[1] ?? "",
        `days[${currentDay.order}].exercises[${exerciseIndex}].rampUps[${setIndex}]`,
        sourceOrder,
      );
      if (!parsed) return null;
      currentExercise.rampUps.push(parsed.item);
      ambiguities.push(...parsed.ambiguities);
      canAttachExerciseDetails = true;
      continue;
    }

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
    const loadUnit = tail.groups.loadUnit?.toLowerCase() as
      | "kg"
      | "lb"
      | undefined;
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
      rampUps: [],
    });
    canAttachExerciseDetails = true;
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

  const draft = routineParseDraftSchema.safeParse({
    data: { programName, days },
    confidence: ambiguities.length > 0 ? 0.85 : 1,
    ambiguities,
    clarifyingQuestions: [],
    unparsed: [],
  });
  if (!draft.success) return null;
  return normalizeRoutineParseDraftEnvelope(draft.data, input);
}
