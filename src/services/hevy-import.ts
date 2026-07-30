import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { externalExerciseMappings, importEvents } from "@/db/schema";
import {
  LONG_WORKOUT_DURATION_FLAG,
  MAX_ANALYTICS_WORKOUT_DURATION_MINUTES,
} from "@/lib/workout-duration-quality";
import {
  extractExerciseIdentity,
  loadVisibleExercises,
  normalizeExerciseText,
  resolveExerciseNameFromLibrary,
} from "@/services/exercise-map";

export const HEVY_HEADERS = [
  "title",
  "start_time",
  "end_time",
  "description",
  "exercise_title",
  "superset_id",
  "exercise_notes",
  "set_index",
  "set_type",
  "weight_lbs",
  "reps",
  "distance_km",
  "duration_seconds",
  "rpe",
] as const;

export const HEVY_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const HEVY_MAX_ROWS = 25_000;
export const HEVY_MAX_RECORD_BYTES = 64 * 1024;
export const HEVY_MAX_DISTINCT_EXERCISES = 1_500;

type HevyHeader = (typeof HEVY_HEADERS)[number];
type CsvRecord = Record<HevyHeader, string>;

export type HevyMetricType =
  | "weight_reps"
  | "reps"
  | "assisted_reps"
  | "duration"
  | "distance_duration"
  | "activity";

export type HevySetRow = {
  sourceRow: number;
  title: string;
  startTime: string;
  endTime: string;
  description: string;
  exerciseTitle: string;
  supersetId: string | null;
  exerciseNotes: string | null;
  setIndex: number;
  setType: "normal" | "warmup";
  weightLbs: number | null;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
  rpe: number | null;
  metricType: HevyMetricType;
};

export type HevyExerciseOccurrence = {
  occurrenceIndex: number;
  sourceKey: string;
  rawName: string;
  supersetId: string | null;
  notes: string | null;
  rows: HevySetRow[];
};

export type HevyWorkout = {
  sourceKey: string;
  title: string;
  description: string | null;
  rawStartTime: string;
  rawEndTime: string;
  startedAt: Date;
  finishedAt: Date;
  durationMinutes: number;
  excludeDurationFromAnalytics: boolean;
  dataQualityFlags: string[];
  occurrences: HevyExerciseOccurrence[];
};

export type HevyExerciseSummary = {
  key: string;
  rawName: string;
  equipment: string | null;
  assistance: "assisted" | "weighted" | null;
  setCount: number;
  workoutCount: number;
  metricTypes: HevyMetricType[];
  sampleWeights: number[];
  sampleNotes: string[];
};

export type HevyProfile = {
  workouts: number;
  exerciseOccurrences: number;
  sets: number;
  warmupSets: number;
  normalSets: number;
  supersetGroups: number;
  distinctExercises: number;
  earliest: string;
  latest: string;
  warnings: Array<{
    code: string;
    message: string;
    sourceRow?: number;
  }>;
};

export type ParsedHevyExport = {
  fileHash: string;
  timezone: string;
  profile: HevyProfile;
  exercises: HevyExerciseSummary[];
  workouts: HevyWorkout[];
};

export type HevyReviewCandidate = {
  id: string;
  name: string;
  family: string | null;
  loadType: string;
  metricType: string;
  equipment: string[];
};

export type HevyExerciseReview = HevyExerciseSummary & {
  previousMapping: boolean;
  suggestedExerciseId: string | null;
  suggestedExerciseName: string | null;
  matchType: "confirmed" | "exact" | "alias" | "suggested" | "none";
  safeForBulk: boolean;
  reason: string;
  candidates: HevyReviewCandidate[];
};

export type StagedHevyPayload = {
  kind: "hevy_history";
  schemaVersion: "1";
  originalFilename: string;
  fileHash: string;
  timezone: string;
  profile: HevyProfile;
  exercises: HevyExerciseReview[];
};

export type StagedHevyImport = StagedHevyPayload & { importEventId: string };

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function boundedText(
  value: unknown,
  field: string,
  sourceRow: number,
  maxLength: number
) {
  const parsed = text(value);
  if (parsed.length > maxLength) {
    throw new Error(
      `Hevy row ${sourceRow}: ${field} exceeds the ${maxLength}-character limit.`
    );
  }
  return parsed;
}

function optionalNumber(value: unknown, field: string, sourceRow: number): number | null {
  const cleaned = text(value);
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Hevy row ${sourceRow}: ${field} is not a valid number.`);
  }
  return parsed;
}

function requiredSetIndex(value: unknown, sourceRow: number): number {
  const parsed = optionalNumber(value, "set_index", sourceRow);
  if (parsed == null || !Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
    throw new Error(
      `Hevy row ${sourceRow}: set_index must be a whole number from 0 to 100000.`
    );
  }
  return parsed;
}

function inferMetricType(input: {
  exerciseTitle: string;
  assistance: "assisted" | "weighted" | null;
  weightLbs: number | null;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
}): HevyMetricType {
  if ((input.distanceKm ?? 0) > 0) return "distance_duration";
  if (
    (input.durationSeconds ?? 0) > 0 &&
    (input.reps == null || input.reps === 0)
  ) {
    return "duration";
  }
  if (input.assistance === "assisted") return "assisted_reps";
  if (input.weightLbs != null) return "weight_reps";
  if (input.reps != null && input.reps > 0) return "reps";
  if (normalizeExerciseText(input.exerciseTitle) === "warm up") return "activity";
  return (input.durationSeconds ?? 0) > 0 ? "duration" : "activity";
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function timezoneOffsetMs(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return (
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    ) - date.getTime()
  );
}

export function parseHevyLocalDate(value: string, timezone: string): Date {
  // Validate the IANA timezone before doing any arithmetic.
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  const match = value.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)$/
  );
  if (!match) throw new Error(`Unsupported Hevy date: ${value}`);
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = match;
  let hour = Number(hourText) % 12;
  if (meridiem === "PM") hour += 12;
  const wallClock = Date.UTC(
    Number(yearText),
    MONTHS[monthName],
    Number(dayText),
    hour,
    Number(minuteText),
    0
  );
  const wallDate = new Date(wallClock);
  if (
    Number(yearText) < 1900 ||
    Number(yearText) > 2100 ||
    wallDate.getUTCFullYear() !== Number(yearText) ||
    wallDate.getUTCMonth() !== MONTHS[monthName] ||
    wallDate.getUTCDate() !== Number(dayText) ||
    wallDate.getUTCHours() !== hour ||
    wallDate.getUTCMinutes() !== Number(minuteText)
  ) {
    throw new Error(`Unsupported Hevy date: ${value}`);
  }
  let result = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), timezone));
  // One correction handles offsets that differ around a DST boundary.
  result = new Date(wallClock - timezoneOffsetMs(result, timezone));
  return result;
}

/**
 * A set duration is treated as suspicious (kept, but excluded from derived
 * insights) when it exceeds its own workout, or when a rep-based set claims
 * more than ten minutes. Timed work — cardio, holds, distance efforts, and
 * activity entries — is expected to run long, so genuine steady-state
 * sessions are never swept out of the analytics.
 */
export function isSuspiciousSetDuration(input: {
  durationSeconds: number | null;
  metricType: HevyMetricType;
  workoutSeconds: number;
}): boolean {
  const duration = input.durationSeconds ?? 0;
  if (duration <= 0) return false;
  if (duration > input.workoutSeconds) return true;
  const timed =
    input.metricType === "duration" ||
    input.metricType === "distance_duration" ||
    input.metricType === "activity";
  return !timed && duration > 600;
}

function workoutSourceKey(title: string, start: string, end: string): string {
  return createHash("sha256")
    .update([title, start, end].join("\u001f"))
    .digest("hex");
}

export function hevyMappingKey(rawName: string): string {
  const hints = extractExerciseIdentity(rawName);
  // Preserve the complete source wording. Synonyms such as "pressdown" and
  // "pushdown" may be equivalent candidates, but they are separate Hevy
  // source entries and each must remain visible for explicit confirmation.
  const sourceName = rawName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return [sourceName, hints.equipment ?? "", hints.assistance ?? ""].join("|");
}

// sourceRow is the real CSV line the record ends on (from the parser), so
// blank lines and multi-line quoted notes cannot drift the reported rows.
function buildRow(record: CsvRecord, sourceRow: number): HevySetRow {
  const title = boundedText(record.title, "title", sourceRow, 200);
  const startTime = boundedText(record.start_time, "start_time", sourceRow, 64);
  const endTime = boundedText(record.end_time, "end_time", sourceRow, 64);
  const exerciseTitle = boundedText(
    record.exercise_title,
    "exercise_title",
    sourceRow,
    200
  );
  if (!title || !startTime || !endTime || !exerciseTitle) {
    throw new Error(`Hevy row ${sourceRow}: workout, dates, and exercise are required.`);
  }
  const setType = boundedText(record.set_type, "set_type", sourceRow, 20);
  if (setType !== "normal" && setType !== "warmup") {
    throw new Error(`Hevy row ${sourceRow}: unsupported set_type "${setType}".`);
  }
  const weightLbs = optionalNumber(record.weight_lbs, "weight_lbs", sourceRow);
  const reps = optionalNumber(record.reps, "reps", sourceRow);
  const distanceKm = optionalNumber(record.distance_km, "distance_km", sourceRow);
  const durationSeconds = optionalNumber(
    record.duration_seconds,
    "duration_seconds",
    sourceRow
  );
  const rpe = optionalNumber(record.rpe, "rpe", sourceRow);
  for (const [field, number] of [
    ["weight_lbs", weightLbs],
    ["reps", reps],
    ["distance_km", distanceKm],
    ["duration_seconds", durationSeconds],
  ] as const) {
    if (number != null && number < 0) {
      throw new Error(`Hevy row ${sourceRow}: ${field} cannot be negative.`);
    }
  }
  if (weightLbs != null && weightLbs > 10_000) {
    throw new Error(`Hevy row ${sourceRow}: weight_lbs exceeds 10000.`);
  }
  if (reps != null && reps > 10_000) {
    throw new Error(`Hevy row ${sourceRow}: reps exceeds 10000.`);
  }
  if (distanceKm != null && distanceKm > 10_000) {
    throw new Error(`Hevy row ${sourceRow}: distance_km exceeds 10000.`);
  }
  if (durationSeconds != null && durationSeconds > 7 * 24 * 60 * 60) {
    throw new Error(`Hevy row ${sourceRow}: duration_seconds exceeds seven days.`);
  }
  if (reps != null && !Number.isInteger(reps)) {
    throw new Error(`Hevy row ${sourceRow}: reps must be a whole number.`);
  }
  if (rpe != null && (rpe < 1 || rpe > 10)) {
    throw new Error(`Hevy row ${sourceRow}: RPE must be between 1 and 10.`);
  }
  const assistance = extractExerciseIdentity(exerciseTitle).assistance;
  return {
    sourceRow,
    title,
    startTime,
    endTime,
    description: boundedText(record.description, "description", sourceRow, 10_000),
    exerciseTitle,
    supersetId:
      boundedText(record.superset_id, "superset_id", sourceRow, 120) || null,
    exerciseNotes:
      boundedText(record.exercise_notes, "exercise_notes", sourceRow, 5_000) ||
      null,
    setIndex: requiredSetIndex(record.set_index, sourceRow),
    setType,
    weightLbs,
    reps,
    distanceKm,
    durationSeconds,
    rpe,
    metricType: inferMetricType({
      exerciseTitle,
      assistance,
      weightLbs,
      reps,
      distanceKm,
      durationSeconds,
    }),
  };
}

export function parseHevyCsv(csv: string, timezone: string): ParsedHevyExport {
  if (Buffer.byteLength(csv, "utf8") > HEVY_MAX_FILE_BYTES) {
    throw new Error("Hevy export is larger than the 20 MB import limit.");
  }
  // Count logical records without allocating one object per row. Embedded
  // newlines inside quoted notes are ignored, and malformed quoting is still
  // rejected by csv-parse below.
  let quoted = false;
  let logicalLines = 1;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (character === "\n" && !quoted) {
      logicalLines += 1;
      if (logicalLines > HEVY_MAX_ROWS + 2) {
        throw new Error(`Hevy export exceeds the ${HEVY_MAX_ROWS}-row limit.`);
      }
    }
  }
  let headersChecked = false;
  const records = parse(csv, {
    columns: (headers: string[]) => {
      const exact =
        headers.length === HEVY_HEADERS.length &&
        headers.every((header, index) => header === HEVY_HEADERS[index]);
      if (!exact) {
        throw new Error(
          `Hevy export headers must be exactly: ${HEVY_HEADERS.join(", ")}.`
        );
      }
      headersChecked = true;
      return headers;
    },
    bom: true,
    skip_empty_lines: true,
    trim: false,
    info: true,
    max_record_size: HEVY_MAX_RECORD_BYTES,
  }) as Array<{ record: CsvRecord; info: { lines: number } }>;
  if (!headersChecked) throw new Error("The Hevy export is missing its header row.");
  if (!records.length) throw new Error("The Hevy export contains no workout rows.");
  if (records.length > HEVY_MAX_ROWS) {
    throw new Error(`Hevy export exceeds the ${HEVY_MAX_ROWS}-row limit.`);
  }
  const rows = records.map(({ record, info }) => buildRow(record, info.lines));
  const workoutGroups = new Map<string, HevySetRow[]>();
  for (const row of rows) {
    const key = [row.title, row.startTime, row.endTime].join("\u001f");
    const group = workoutGroups.get(key) ?? [];
    group.push(row);
    workoutGroups.set(key, group);
  }

  const warnings: HevyProfile["warnings"] = [];
  const workouts: HevyWorkout[] = [];
  const exerciseWorkouts = new Map<string, Set<string>>();
  const exerciseRows = new Map<string, HevySetRow[]>();
  let occurrenceCount = 0;
  const supersetGroups = new Set<string>();

  for (const group of workoutGroups.values()) {
    const first = group[0];
    const startedAt = parseHevyLocalDate(first.startTime, timezone);
    const finishedAt = parseHevyLocalDate(first.endTime, timezone);
    if (finishedAt < startedAt) {
      throw new Error(`Hevy workout "${first.title}" ends before it starts.`);
    }
    const sourceKey = workoutSourceKey(first.title, first.startTime, first.endTime);
    const durationMinutes = (finishedAt.getTime() - startedAt.getTime()) / 60000;
    if (durationMinutes > 7 * 24 * 60) {
      throw new Error(`Hevy workout "${first.title}" exceeds seven days.`);
    }
    const dataQualityFlags: string[] = [];
    if (durationMinutes > MAX_ANALYTICS_WORKOUT_DURATION_MINUTES) {
      dataQualityFlags.push(LONG_WORKOUT_DURATION_FLAG);
      warnings.push({
        code: LONG_WORKOUT_DURATION_FLAG,
        message: `${first.title} on ${first.startTime} is ${Math.round(durationMinutes)} minutes.`,
      });
    }

    const occurrences: HevyExerciseOccurrence[] = [];
    let current: HevyExerciseOccurrence | null = null;
    for (const row of group) {
      const setDuration = row.durationSeconds ?? 0;
      const workoutSeconds = durationMinutes * 60;
      if (setDuration > workoutSeconds && setDuration > 0) {
        warnings.push({
          code: "set_duration_exceeds_workout",
          message: `${row.exerciseTitle} duration exceeds its workout duration and will be excluded from derived duration insights.`,
          sourceRow: row.sourceRow,
        });
      } else if (
        isSuspiciousSetDuration({
          durationSeconds: row.durationSeconds,
          metricType: row.metricType,
          workoutSeconds,
        })
      ) {
        warnings.push({
          code: "set_duration_over_10m",
          message: `${row.exerciseTitle} records ${Math.round(setDuration / 60)} minutes for one rep-based set and will be excluded from derived duration insights until reviewed.`,
          sourceRow: row.sourceRow,
        });
      }
      if (!current || current.rawName !== row.exerciseTitle) {
        const occurrenceIndex = occurrences.length;
        current = {
          occurrenceIndex,
          sourceKey: `${sourceKey}:${occurrenceIndex}`,
          rawName: row.exerciseTitle,
          supersetId: row.supersetId,
          notes: row.exerciseNotes,
          rows: [],
        };
        occurrences.push(current);
      }
      current.rows.push(row);
      if (!current.notes && row.exerciseNotes) current.notes = row.exerciseNotes;
      const key = hevyMappingKey(row.exerciseTitle);
      const workoutSet = exerciseWorkouts.get(key) ?? new Set<string>();
      workoutSet.add(sourceKey);
      exerciseWorkouts.set(key, workoutSet);
      const exerciseSetRows = exerciseRows.get(key) ?? [];
      exerciseSetRows.push(row);
      exerciseRows.set(key, exerciseSetRows);
    }
    occurrenceCount += occurrences.length;

    const localSupersets = new Map<string, Set<string>>();
    for (const occurrence of occurrences) {
      if (!occurrence.supersetId) continue;
      const names = localSupersets.get(occurrence.supersetId) ?? new Set<string>();
      names.add(occurrence.rawName);
      localSupersets.set(occurrence.supersetId, names);
    }
    for (const [id, names] of localSupersets) {
      if (names.size >= 2) supersetGroups.add(`${sourceKey}:${id}`);
    }

    workouts.push({
      sourceKey,
      title: first.title,
      description: first.description || null,
      rawStartTime: first.startTime,
      rawEndTime: first.endTime,
      startedAt,
      finishedAt,
      durationMinutes,
      excludeDurationFromAnalytics:
        durationMinutes > MAX_ANALYTICS_WORKOUT_DURATION_MINUTES,
      dataQualityFlags,
      occurrences,
    });
  }

  const exercises: HevyExerciseSummary[] = [...exerciseRows.entries()]
    .map(([key, exerciseSetRows]) => {
      const rawName = exerciseSetRows[0].exerciseTitle;
      const hints = extractExerciseIdentity(rawName);
      return {
        key,
        rawName,
        equipment: hints.equipment,
        assistance: hints.assistance,
        setCount: exerciseSetRows.length,
        workoutCount: exerciseWorkouts.get(key)?.size ?? 0,
        metricTypes: [...new Set(exerciseSetRows.map((row) => row.metricType))],
        sampleWeights: [
          ...new Set(
            exerciseSetRows
              .map((row) => row.weightLbs)
              .filter((weight): weight is number => weight != null)
          ),
        ].slice(0, 4),
        sampleNotes: [
          ...new Set(
            exerciseSetRows
              .map((row) => row.exerciseNotes)
              .filter((note): note is string => !!note)
          ),
        ].slice(0, 3),
      };
    })
    .sort((a, b) => b.setCount - a.setCount || a.rawName.localeCompare(b.rawName));
  if (exercises.length > HEVY_MAX_DISTINCT_EXERCISES) {
    throw new Error(
      `Hevy export exceeds the ${HEVY_MAX_DISTINCT_EXERCISES}-exercise review limit.`
    );
  }

  const orderedWorkouts = workouts.sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
  );
  return {
    fileHash: createHash("sha256").update(csv).digest("hex"),
    timezone,
    profile: {
      workouts: orderedWorkouts.length,
      exerciseOccurrences: occurrenceCount,
      sets: rows.length,
      warmupSets: rows.filter((row) => row.setType === "warmup").length,
      normalSets: rows.filter((row) => row.setType === "normal").length,
      supersetGroups: supersetGroups.size,
      distinctExercises: exercises.length,
      earliest: orderedWorkouts.at(-1)!.startedAt.toISOString(),
      latest: orderedWorkouts[0].startedAt.toISOString(),
      warnings,
    },
    exercises,
    workouts: orderedWorkouts,
  };
}

function isStagedPayload(value: unknown): value is StagedHevyPayload {
  const candidate = value as Partial<StagedHevyPayload> | null;
  return candidate?.kind === "hevy_history" &&
    candidate.schemaVersion === "1" &&
    !!candidate.profile &&
    Array.isArray(candidate.exercises);
}

export async function buildHevyExerciseReviews(
  db: Db,
  userId: string,
  parsed: ParsedHevyExport
): Promise<HevyExerciseReview[]> {
  const previous = await db.query.externalExerciseMappings.findMany({
    where: and(
      eq(externalExerciseMappings.userId, userId),
      eq(externalExerciseMappings.source, "hevy")
    ),
    with: { exercise: { with: { family: true, equipmentRequirements: true } } },
  });
  const previousByKey = new Map(previous.map((mapping) => [mapping.normalizedKey, mapping]));
  // One library load for the whole review; per-name reloads made staging a
  // large export one round-trip per distinct exercise.
  const visible = await loadVisibleExercises(db, userId);

  const reviews: HevyExerciseReview[] = [];
  for (const summary of parsed.exercises) {
    const confirmed = previousByKey.get(summary.key);
    if (confirmed) {
      reviews.push({
        ...summary,
        previousMapping: true,
        suggestedExerciseId: confirmed.exercise.id,
        suggestedExerciseName: confirmed.exercise.name,
        matchType: "confirmed",
        safeForBulk: true,
        reason: "You confirmed this Hevy mapping previously.",
        candidates: [],
      });
      continue;
    }
    const resolution = resolveExerciseNameFromLibrary(visible, summary.rawName);
    const sourceMetrics = new Set(summary.metricTypes);
    const targetMetric = resolution.matchedExercise?.metricType;
    const metricAgrees = targetMetric != null && (
      sourceMetrics.size === 1 && sourceMetrics.has(targetMetric as HevyMetricType) ||
      targetMetric === "weight_reps" &&
        [...sourceMetrics].every((metric) => metric === "weight_reps" || metric === "reps")
    );
    const safe =
      (resolution.matchType === "exact" || resolution.matchType === "alias") &&
      metricAgrees;
    reviews.push({
      ...summary,
      previousMapping: false,
      suggestedExerciseId: resolution.exerciseId,
      suggestedExerciseName: resolution.exerciseName,
      matchType: resolution.matchType,
      safeForBulk: safe,
      reason: safe
        ? "Name, equipment, assistance, and metric identity agree."
        : resolution.exerciseId
          ? `Name and equipment match ${resolution.exerciseName}, but the source metric differs; confirm it manually.`
        : resolution.candidates.length
          ? "These are equipment-compatible suggestions; confirm one or create the genuine variant."
          : "No safe catalog match was found.",
      candidates: resolution.candidates,
    });
  }
  return reviews;
}

export async function getLatestStagedHevyImport(
  db: Db,
  userId: string
): Promise<StagedHevyImport | null> {
  const event = await db.query.importEvents.findFirst({
    where: and(
      eq(importEvents.userId, userId),
      eq(importEvents.source, "csv"),
      eq(importEvents.status, "parsed")
    ),
    orderBy: desc(importEvents.createdAt),
  });
  if (!event || !isStagedPayload(event.parsedPayload)) return null;
  return { importEventId: event.id, ...event.parsedPayload };
}
