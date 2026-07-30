export const ACTIVE_WORKOUT_MEASUREMENT_STORAGE_KEY =
  "workout-tracker:active-workout-measurements:v1";
export const ACTIVE_WORKOUT_MEASUREMENT_CHANGE_EVENT =
  "active-workout-measurements-change";
export const ACTIVE_WORKOUT_MEASUREMENT_LIMIT = 100;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ActiveWorkoutSaveOutcome =
  | "saved"
  | "delayed"
  | "retried"
  | "failed";

export type ActiveWorkoutSetMeasurement = {
  version: 1;
  clientKey: string;
  setId?: string | null;
  readyAtISO: string;
  submittedAtISO: string;
  acknowledgedAtISO: string | null;
  durationMs: number | null;
  taps: number;
  focusChanges: number;
  corrections: number;
  outcome: ActiveWorkoutSaveOutcome;
};

type Envelope = { version: 1; records: ActiveWorkoutSetMeasurement[] };
type MeasurementStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validRecord(value: unknown): value is ActiveWorkoutSetMeasurement {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.clientKey === "string" &&
    (value.setId == null || typeof value.setId === "string") &&
    typeof value.readyAtISO === "string" &&
    typeof value.submittedAtISO === "string" &&
    (value.acknowledgedAtISO === null || typeof value.acknowledgedAtISO === "string") &&
    (value.durationMs === null ||
      (typeof value.durationMs === "number" && value.durationMs >= 0)) &&
    typeof value.taps === "number" &&
    value.taps >= 0 &&
    typeof value.focusChanges === "number" &&
    value.focusChanges >= 0 &&
    typeof value.corrections === "number" &&
    value.corrections >= 0 &&
    ["saved", "delayed", "retried", "failed"].includes(String(value.outcome))
  );
}

export function parseActiveWorkoutMeasurements(
  raw: string | null,
  now = Date.now()
): ActiveWorkoutSetMeasurement[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) {
      return [];
    }
    return value.records
      .filter(validRecord)
      .filter(
        (record) => now - Date.parse(record.submittedAtISO) <= RETENTION_MS
      )
      .slice(-ACTIVE_WORKOUT_MEASUREMENT_LIMIT);
  } catch {
    return [];
  }
}

export function readActiveWorkoutMeasurements(
  storage: MeasurementStorage = window.localStorage
) {
  return parseActiveWorkoutMeasurements(
    storage.getItem(ACTIVE_WORKOUT_MEASUREMENT_STORAGE_KEY)
  );
}

export function writeActiveWorkoutMeasurement(
  record: ActiveWorkoutSetMeasurement,
  storage: MeasurementStorage = window.localStorage
) {
  const current = readActiveWorkoutMeasurements(storage);
  const withoutSame = current.filter(
    (candidate) => candidate.clientKey !== record.clientKey
  );
  const envelope: Envelope = {
    version: 1,
    records: [...withoutSame, record].slice(-ACTIVE_WORKOUT_MEASUREMENT_LIMIT),
  };
  storage.setItem(
    ACTIVE_WORKOUT_MEASUREMENT_STORAGE_KEY,
    JSON.stringify(envelope)
  );
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ACTIVE_WORKOUT_MEASUREMENT_CHANGE_EVENT));
  }
}

export function patchActiveWorkoutMeasurement(
  clientKey: string,
  patch: Partial<ActiveWorkoutSetMeasurement>,
  storage: MeasurementStorage = window.localStorage
) {
  const current = readActiveWorkoutMeasurements(storage);
  const record = current.find((candidate) => candidate.clientKey === clientKey);
  if (!record) return;
  writeActiveWorkoutMeasurement({ ...record, ...patch, clientKey }, storage);
}

export function clearActiveWorkoutMeasurements(
  storage: MeasurementStorage = window.localStorage
) {
  storage.removeItem(ACTIVE_WORKOUT_MEASUREMENT_STORAGE_KEY);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ACTIVE_WORKOUT_MEASUREMENT_CHANGE_EVENT));
  }
}
