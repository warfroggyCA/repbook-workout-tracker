import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  ACTIVITY_INTENSITIES,
  ACTIVITY_TYPES,
  MAX_ACTIVITY_DURATION_SECONDS,
  type ActivityInput,
  type ActivityType,
} from "@/lib/activities";

export type RecentActivityPreset = {
  activityType: ActivityType;
  title: string;
};

function normalizedPresetTitle(title: string) {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function recentNamedActivityPresets(
  records: Array<{ activityType: string; title: string | null }>,
  limit = 6,
): RecentActivityPreset[] {
  const supportedTypes = new Set(ACTIVITY_TYPES.map((option) => option.id));
  const seen = new Set<string>();
  const presets: RecentActivityPreset[] = [];
  for (const record of records) {
    const title = record.title?.trim().replace(/\s+/g, " ") ?? "";
    if (!title || !supportedTypes.has(record.activityType as ActivityType)) continue;
    const key = `${record.activityType}:${normalizedPresetTitle(title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({
      activityType: record.activityType as ActivityType,
      title,
    });
    if (presets.length >= limit) break;
  }
  return presets;
}

/** Recent manual names are shortcuts only; no prior measurements are copied. */
export async function getRecentNamedActivityPresets(
  db: Db,
  userId: string,
): Promise<RecentActivityPreset[]> {
  const rows = resultRows(await db.execute(sql`
    SELECT activity_type, title
    FROM health_activities
    WHERE user_id = ${userId}::uuid
      AND source = 'manual'
      AND archived_at IS NULL
      AND title IS NOT NULL
      AND btrim(title) <> ''
    ORDER BY started_at DESC, id DESC
    LIMIT 50
  `));
  return recentNamedActivityPresets(rows.map((row) => ({
    activityType: String(row.activity_type),
    title: row.title == null ? null : String(row.title),
  })));
}

const activityTypeIds = ACTIVITY_TYPES.map((option) => option.id) as [
  ActivityInput["activityType"],
  ...ActivityInput["activityType"][],
];
const intensityIds = ACTIVITY_INTENSITIES.map((option) => option.id) as [
  NonNullable<ActivityInput["intensity"]>,
  ...NonNullable<ActivityInput["intensity"]>[],
];

export const activityInputSchema = z.object({
  activityType: z.enum(activityTypeIds),
  title: z.string().trim().max(120).nullable(),
  startedAtISO: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Choose a valid activity date and time.",
  }),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    }, "Choose a valid timezone."),
  durationSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_ACTIVITY_DURATION_SECONDS)
    .optional(),
  durationMinutes: z.number().int().min(1).max(10_080).optional(),
  distanceValue: z.number().finite().positive().max(10_000).nullable(),
  distanceUnit: z.enum(["km", "mi"]),
  intensity: z.enum(intensityIds).nullable(),
  elevationValue: z.number().finite().nonnegative().max(100_000).nullable(),
  elevationUnit: z.enum(["m", "ft"]),
  averageHeartRateBpm: z.number().int().min(20).max(260).nullable(),
  energyKcal: z.number().finite().positive().max(100_000).nullable(),
  notes: z.string().trim().max(4_000).nullable(),
}).superRefine((value, context) => {
  const supplied = Number(value.durationSeconds != null) +
    Number(value.durationMinutes != null);
  if (supplied !== 1) {
    context.addIssue({
      code: "custom",
      path: ["durationSeconds"],
      message: "Provide one activity duration in exact seconds or whole minutes.",
    });
  }
});

export type NormalizedActivity = ReturnType<typeof normalizeActivityInput>;

function emptyToNull(value: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

export function activityFingerprint(input: {
  activityType: string;
  startedAt: Date;
  durationSeconds: number;
  distanceKm: number | null;
}) {
  return [
    "v1",
    input.activityType,
    input.startedAt.toISOString(),
    input.durationSeconds,
    input.distanceKm?.toFixed(6) ?? "",
  ].join("|");
}

export function normalizeActivityInput(input: ActivityInput, now = new Date()) {
  const parsed = activityInputSchema.parse(input);
  const startedAt = new Date(parsed.startedAtISO);
  if (startedAt.getTime() < Date.UTC(1900, 0, 1)) {
    throw new Error("Choose an activity date after 1900.");
  }
  if (startedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("Activities cannot be recorded in the future.");
  }

  const durationSeconds = parsed.durationSeconds ?? parsed.durationMinutes! * 60;
  const distanceKm =
    parsed.distanceValue == null
      ? null
      : parsed.distanceUnit === "mi"
        ? parsed.distanceValue * 1.609344
        : parsed.distanceValue;
  const elevationGainM =
    parsed.elevationValue == null
      ? null
      : parsed.elevationUnit === "ft"
        ? parsed.elevationValue * 0.3048
        : parsed.elevationValue;
  const averagePaceSecondsPerKm =
    distanceKm && distanceKm > 0 ? durationSeconds / distanceKm : null;

  return {
    activityType: parsed.activityType,
    title: emptyToNull(parsed.title),
    startedAt,
    timezone: parsed.timezone,
    durationSeconds,
    distanceKm,
    averagePaceSecondsPerKm,
    intensity: parsed.intensity,
    elevationGainM,
    averageHeartRateBpm: parsed.averageHeartRateBpm,
    energyKcal: parsed.energyKcal,
    notes: emptyToNull(parsed.notes),
    source: "manual" as const,
    sourceMetadata: {},
    originalMetrics: {
      ...(parsed.distanceValue == null
        ? {}
        : {
            distanceValue: parsed.distanceValue,
            distanceUnit: parsed.distanceUnit,
          }),
      ...(parsed.elevationValue == null
        ? {}
        : {
            elevationValue: parsed.elevationValue,
            elevationUnit: parsed.elevationUnit,
          }),
    },
    fingerprint: activityFingerprint({
      activityType: parsed.activityType,
      startedAt,
      durationSeconds,
      distanceKm,
    }),
  };
}
