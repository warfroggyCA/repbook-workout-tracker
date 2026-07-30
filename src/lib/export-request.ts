import { z } from "zod";

export const CSV_EXPORT_ENTITIES = [
  "sets",
  "pain",
  "notes",
  "activities",
  "coach",
] as const;

export type CsvExportEntity = (typeof CSV_EXPORT_ENTITIES)[number];

const csvEntitySchema = z.enum(CSV_EXPORT_ENTITIES);
const boundedWeeksSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(260));

function hasOnlySingleParameters(url: URL, allowed: Set<string>) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      return false;
    }
  }
  return true;
}

export function parseCsvExportRequest(url: URL):
  | { ok: true; entity: CsvExportEntity; weeks: number | null }
  | { ok: false } {
  if (!hasOnlySingleParameters(url, new Set(["entity", "weeks"]))) {
    return { ok: false };
  }
  const entity = csvEntitySchema.safeParse(
    url.searchParams.get("entity") ?? "sets"
  );
  const rawWeeks = url.searchParams.get("weeks") ?? "all";
  const weeks =
    rawWeeks === "all"
      ? ({ success: true, data: null } as const)
      : boundedWeeksSchema.safeParse(rawWeeks);
  if (!entity.success || !weeks.success) return { ok: false };
  return { ok: true, entity: entity.data, weeks: weeks.data };
}

export function parseMarkdownExportRequest(url: URL):
  | { ok: true; weeks: number; download: boolean }
  | { ok: false } {
  if (!hasOnlySingleParameters(url, new Set(["weeks", "download"]))) {
    return { ok: false };
  }
  const weeks = boundedWeeksSchema.safeParse(
    url.searchParams.get("weeks") ?? "4"
  );
  const rawDownload = url.searchParams.get("download");
  if (!weeks.success || ![null, "0", "1"].includes(rawDownload)) {
    return { ok: false };
  }
  return { ok: true, weeks: weeks.data, download: rawDownload === "1" };
}

export const CSV_EXPORT_FILENAMES: Record<CsvExportEntity, string> = {
  sets: "workout-sets",
  pain: "pain-and-fatigue",
  notes: "contextual-training-notes",
  activities: "health-activities",
  coach: "live-coach-messages",
};
