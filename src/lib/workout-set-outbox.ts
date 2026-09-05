import {
  PERFORMED_LOAD_SEMANTICS,
  SUPPORTED_SET_WRITER_METRICS,
  validateSetWriterShape,
  type PerformedLoadSemantics,
  type PerformedMetricType,
  type PerformedSetMeasurement,
} from "@/lib/set-metric-semantics";
import {
  LIMITATION_CAUSES,
  PAIN_BODY_PARTS,
  TECHNIQUE_ISSUES,
  type LimitationCause,
  type SetPainContext,
  type TechniqueIssue,
} from "@/lib/set-exception-context";
import {
  clearRestTimerForExactSourceClientKey,
  type RestTimerStorage,
} from "@/lib/rest-timer";

export const WORKOUT_SET_OUTBOX_STORAGE_KEY =
  "workout-tracker:workout-set-outbox:v1";
export const WORKOUT_SET_OUTBOX_LOCK_NAME =
  "workout-tracker:workout-set-outbox";
export const WORKOUT_COMMAND_DELIVERY_LOCK_PREFIX =
  "workout-tracker:workout-command-delivery";
const WORKOUT_COMMAND_SEQUENCE_KEY =
  "workout-tracker:workout-command-sequence:v1";
export const EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_STORAGE_KEY =
  "workout-tracker:equipment-selection-acknowledgements:v1";
export const WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY =
  "workout-tracker:workout-rest-intent-receipts:v1";
export const WORKOUT_SET_OUTBOX_CHANGE_EVENT = "workout-set-outbox-change";
export const WORKOUT_SET_OUTBOX_STATUS_EVENT = "workout-set-outbox-status";
const WORKOUT_SET_OUTBOX_STATUS_CHANNEL = "workout-set-outbox-status-v1";
export const WORKOUT_SET_OUTBOX_MAX_ENTRIES = 100;
export const WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS = 6;
const MAX_EQUIPMENT_SELECTION_ACKNOWLEDGEMENTS = 200;
const EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WORKOUT_REST_INTENT_RECEIPTS = 100;

export type EquipmentSelectionAcknowledgement = {
  clientKey: string;
  ownerId: string;
  sessionId: string;
  sessionExerciseId: string;
  snapshotId: string | null;
  /** Authoritative pending-occurrence revisions after this selection applied. */
  occurrenceStates?: Array<{ id: string; revision: number }>;
  acknowledgedAtISO: string;
};

/**
 * The latest acknowledged explicit rest decision for one workout. Retained
 * commands remain authoritative in the outbox; this receipt survives their
 * acknowledgement while an older command could still replay.
 */
export type WorkoutRestIntentReceipt = {
  clientKey: string;
  ownerId: string;
  sessionId: string;
  createdAtISO: string;
  restAfterSec: number | null;
};

export type WorkoutSetOutboxStatus = "queued" | "needs_attention";
export type WorkoutSetOrderBlocker = {
  occurrenceId: string;
  occurrenceRevision: number;
  sessionExerciseId: string | null;
  exerciseName: string;
  /** Absent only on retained device entries created before preparation blockers. */
  kind?: "working_set" | "day_warmup" | "exercise_warmup";
  setNo: number;
  groupRound: number | null;
  origin: string;
  isAddedSet: boolean;
  label: string;
};
export type WorkoutSetLoadEntryMeaning =
  | "total_system"
  | "per_loading_point"
  | "displayed_stack"
  | "per_stack"
  | "combined_stacks"
  | "legacy_unknown";

type WorkoutSetOutboxCommand = {
  clientKey: string;
  ownerId: string;
  sessionId: string;
  sessionExerciseId: string;
  /** Exact occurrence fence; absent only on legacy retained version-four entries. */
  occurrenceId?: string;
  expectedOccurrenceRevision?: number;
  performedExerciseId: string;
  performedSemanticsVersion: 1;
  performedLoadType: string;
  performedLoadSemantics: PerformedLoadSemantics;
  /** Human-readable workout context; older retained copies may not have it. */
  workoutName?: string;
  exerciseName: string;
  setNo: number;
  rpe: number | null;
  rir: number | null;
  techniqueIssue: TechniqueIssue | null;
  limitationCause: LimitationCause | null;
  pain: SetPainContext | null;
  note: string | null;
  equipmentSnapshotId: string | null;
  /** Pending local selection that must be acknowledged before this set. */
  equipmentSelectionClientKey?: string | null;
  /** Explicit rest intent retained with this exact local set command. */
  restAfterSec?: number | null;
  loadEntryMeaning: WorkoutSetLoadEntryMeaning;
  /**
   * Device-observed completion time frozen with the durable command. Older
   * retained commands are intentionally unknown rather than inferred.
   */
  observedCompletedAtISO: string | null;
  createdAtISO: string;
} & PerformedSetMeasurement;

export type WorkoutSetOutboxEntry = WorkoutSetOutboxCommand & {
  status: WorkoutSetOutboxStatus;
  attemptCount: number;
  nextAttemptAtISO: string | null;
  lastAttemptAtISO: string | null;
  lastError: string | null;
  /** Exact authoritative predecessor returned by an ordered-save rejection. */
  orderBlocker?: WorkoutSetOrderBlocker | null;
  /** Server fence changed; this retained attempt requires review, not blind retry. */
  reviewRequired?: "stale_occurrence" | null;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type NewWorkoutSetOutboxEntry = DistributiveOmit<
  WorkoutSetOutboxEntry,
  | "status"
  | "attemptCount"
  | "nextAttemptAtISO"
  | "lastAttemptAtISO"
  | "lastError"
  | "observedCompletedAtISO"
  | "rir"
  | "techniqueIssue"
  | "limitationCause"
  | "pain"
  | "orderBlocker"
  | "reviewRequired"
> & {
  observedCompletedAtISO?: string | null;
  rir?: number | null;
  techniqueIssue?: TechniqueIssue | null;
  limitationCause?: LimitationCause | null;
  pain?: SetPainContext | null;
};

export type WorkoutSetOutboxSnapshot = {
  entries: WorkoutSetOutboxEntry[];
  quarantined: QuarantinedWorkoutSetOutboxEntry[];
  error: string | null;
};

export type QuarantinedWorkoutSetOutboxEntry = {
  quarantineKey: string;
  raw: unknown;
  reason: string;
};

export type WorkoutSetOutboxClientEvent =
  | {
      type: "saving";
      clientKey: string;
      sessionId: string;
      retrying: boolean;
    }
  | {
      type: "saved";
      clientKey: string;
      sessionId: string;
      setId: string;
      occurrenceId: string;
      occurrenceRevision: number;
      entry: WorkoutSetOutboxEntry;
    }
  | {
      type: "failed";
      clientKey: string;
      sessionId: string;
      blocker?: WorkoutSetOrderBlocker | null;
    }
  | { type: "discarded"; clientKey: string; sessionId: string };

let statusChannel: BroadcastChannel | null = null;

function getStatusChannel() {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return null;
  }
  statusChannel ??= new BroadcastChannel(WORKOUT_SET_OUTBOX_STATUS_CHANNEL);
  return statusChannel;
}

export function publishWorkoutSetOutboxEvent(
  detail: WorkoutSetOutboxClientEvent
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkoutSetOutboxClientEvent>(
      WORKOUT_SET_OUTBOX_STATUS_EVENT,
      { detail }
    )
  );
  getStatusChannel()?.postMessage(detail);
}

export function subscribeToWorkoutSetOutboxStatus(
  listener: (detail: WorkoutSetOutboxClientEvent) => void
) {
  if (typeof window === "undefined") return () => undefined;
  const onWindowEvent = (event: Event) => {
    listener((event as CustomEvent<WorkoutSetOutboxClientEvent>).detail);
  };
  const channel = getStatusChannel();
  const onChannelMessage = (event: MessageEvent<WorkoutSetOutboxClientEvent>) => {
    listener(event.data);
  };
  window.addEventListener(WORKOUT_SET_OUTBOX_STATUS_EVENT, onWindowEvent);
  channel?.addEventListener("message", onChannelMessage);
  return () => {
    window.removeEventListener(WORKOUT_SET_OUTBOX_STATUS_EVENT, onWindowEvent);
    channel?.removeEventListener("message", onChannelMessage);
  };
}

export type WorkoutSetOutboxStorage = Pick<Storage, "getItem" | "setItem">;

type StoredQuarantinedWorkoutSetOutboxEntry = {
  quarantine: "workout-set-outbox-entry-v1";
  raw: unknown;
  reason: string;
};
const WORKOUT_SET_QUARANTINE_REASONS = [
  "This saved workout set is incomplete or invalid.",
  "This saved workout set uses an older recording format and needs review.",
  "This saved workout set repeats an earlier identity.",
  "This saved workout set repeats an earlier set number.",
] as const;
type WorkoutSetQuarantineReason =
  (typeof WORKOUT_SET_QUARANTINE_REASONS)[number];
type OutboxEnvelope = {
  version: 4;
  entries: unknown[];
};
type MutationResult =
  | { ok: true; entry: WorkoutSetOutboxEntry | null }
  | { ok: false; reason: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_SNAPSHOT: WorkoutSetOutboxSnapshot = {
  entries: [],
  quarantined: [],
  error: null,
};
let cachedRaw: string | null | undefined;
let cachedSnapshot = EMPTY_SNAPSHOT;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasSameRawValue(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isEquipmentSelectionAcknowledgement(
  value: unknown,
): value is EquipmentSelectionAcknowledgement {
  return isRecord(value) &&
    typeof value.clientKey === "string" && UUID_PATTERN.test(value.clientKey) &&
    typeof value.ownerId === "string" && UUID_PATTERN.test(value.ownerId) &&
    typeof value.sessionId === "string" && UUID_PATTERN.test(value.sessionId) &&
    typeof value.sessionExerciseId === "string" &&
    UUID_PATTERN.test(value.sessionExerciseId) &&
    (value.snapshotId === null ||
      (typeof value.snapshotId === "string" && UUID_PATTERN.test(value.snapshotId))) &&
    (value.occurrenceStates === undefined ||
      (Array.isArray(value.occurrenceStates) &&
        value.occurrenceStates.every(
          (state) =>
            isRecord(state) &&
            typeof state.id === "string" &&
            UUID_PATTERN.test(state.id) &&
            typeof state.revision === "number" &&
            Number.isInteger(state.revision) &&
            state.revision >= 0,
        ))) &&
    isDate(value.acknowledgedAtISO);
}

function readEquipmentSelectionAcknowledgements(
  storage: WorkoutSetOutboxStorage,
  now = new Date(),
): EquipmentSelectionAcknowledgement[] {
  try {
    const raw = storage.getItem(EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_STORAGE_KEY);
    if (raw == null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return [];
    }
    const cutoff = now.getTime() - EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_TTL_MS;
    return parsed.entries.filter(isEquipmentSelectionAcknowledgement).filter(
      (entry) => Date.parse(entry.acknowledgedAtISO) >= cutoff,
    );
  } catch {
    return [];
  }
}

export function recordEquipmentSelectionAcknowledgement(
  storage: WorkoutSetOutboxStorage,
  acknowledgement: EquipmentSelectionAcknowledgement,
  now = new Date(),
) {
  if (!isEquipmentSelectionAcknowledgement(acknowledgement)) {
    return { ok: false as const, reason: "The equipment acknowledgement was invalid." };
  }
  const cutoff = now.getTime() - EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_TTL_MS;
  const retained = readEquipmentSelectionAcknowledgements(storage, now).filter(
    (entry) =>
      entry.clientKey !== acknowledgement.clientKey &&
      Date.parse(entry.acknowledgedAtISO) >= cutoff,
  );
  try {
    storage.setItem(
      EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: [...retained, acknowledgement].slice(
          -MAX_EQUIPMENT_SELECTION_ACKNOWLEDGEMENTS,
        ),
      }),
    );
    return { ok: true as const };
  } catch {
    return {
      ok: false as const,
      reason: "This browser could not retain the equipment acknowledgement.",
    };
  }
}

function resolveAcknowledgedEquipmentDependency(
  storage: WorkoutSetOutboxStorage,
  input: NewWorkoutSetOutboxEntry,
  requireResolvableDependency: boolean,
): NewWorkoutSetOutboxEntry | { reason: string } {
  const dependency = input.equipmentSelectionClientKey ?? null;
  if (dependency == null) return input;
  const acknowledgement = readEquipmentSelectionAcknowledgements(storage).find(
    (entry) => entry.clientKey === dependency,
  );
  if (!acknowledgement) {
    if (!requireResolvableDependency) return input;
    try {
      const raw = storage.getItem("workout-tracker:equipment-selection-outbox:v1");
      const parsed: unknown = raw == null ? null : JSON.parse(raw);
      const live = isRecord(parsed) && Array.isArray(parsed.entries) &&
        parsed.entries.some(
          (entry) => isRecord(entry) && entry.clientKey === dependency,
        );
      if (live) return input;
    } catch {
      // The fail-closed result below keeps an unreadable dependency out of the set queue.
    }
    return {
      reason:
        "The equipment choice changed before this set could be retained. Review the current setup and log the set again.",
    };
  }
  if (
    acknowledgement.ownerId !== input.ownerId ||
    acknowledgement.sessionId !== input.sessionId ||
    acknowledgement.sessionExerciseId !== input.sessionExerciseId
  ) {
    return { reason: "The acknowledged equipment choice belongs to different workout values." };
  }
  if (acknowledgement.snapshotId == null) {
    return { reason: "The acknowledged equipment choice did not retain a usable setup." };
  }
  const acknowledgedOccurrenceRevision = input.occurrenceId == null
    ? undefined
    : acknowledgement.occurrenceStates?.find(
        (state) => state.id === input.occurrenceId,
      )?.revision;
  return {
    ...input,
    equipmentSelectionClientKey: null,
    equipmentSnapshotId: acknowledgement.snapshotId,
    ...(acknowledgedOccurrenceRevision == null
      ? {}
      : { expectedOccurrenceRevision: acknowledgedOccurrenceRevision }),
  };
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || isDate(value);
}

function isNullableNumber(value: unknown, min: number, max: number) {
  return value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}

function isPerformedLoadSemantics(
  value: unknown,
): value is PerformedLoadSemantics {
  return typeof value === "string" && PERFORMED_LOAD_SEMANTICS.includes(
    value as PerformedLoadSemantics,
  );
}

function isWorkoutSetLoadEntryMeaning(
  value: unknown,
): value is WorkoutSetLoadEntryMeaning {
  return value === "total_system" ||
    value === "per_loading_point" ||
    value === "displayed_stack" ||
    value === "per_stack" ||
    value === "combined_stacks" ||
    value === "legacy_unknown";
}

function isWorkoutSetOrderBlocker(
  value: unknown,
): value is WorkoutSetOrderBlocker {
  return isRecord(value) &&
    typeof value.occurrenceId === "string" &&
    UUID_PATTERN.test(value.occurrenceId) &&
    Number.isInteger(value.occurrenceRevision) &&
    Number(value.occurrenceRevision) >= 0 &&
    ((value.kind === "day_warmup" && value.sessionExerciseId === null) ||
      (value.kind !== "day_warmup" &&
        typeof value.sessionExerciseId === "string" &&
        UUID_PATTERN.test(value.sessionExerciseId))) &&
    typeof value.exerciseName === "string" &&
    value.exerciseName.length > 0 &&
    value.exerciseName.length <= 200 &&
    (value.kind === undefined ||
      value.kind === "working_set" ||
      value.kind === "day_warmup" ||
      value.kind === "exercise_warmup") &&
    Number.isInteger(value.setNo) &&
    (value.kind === "day_warmup" || value.kind === "exercise_warmup"
      ? Number(value.setNo) === 0
      : Number(value.setNo) >= 1 && Number(value.setNo) <= 50) &&
    (value.groupRound === null || (
      Number.isInteger(value.groupRound) && Number(value.groupRound) >= 1
    )) &&
    typeof value.origin === "string" &&
    value.origin.length > 0 &&
    value.origin.length <= 50 &&
    typeof value.isAddedSet === "boolean" &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 300;
}

function isWorkoutSetOutboxEntry(value: unknown): value is WorkoutSetOutboxEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value.metricType !== "string" ||
    !SUPPORTED_SET_WRITER_METRICS.includes(
      value.metricType as (typeof SUPPORTED_SET_WRITER_METRICS)[number],
    ) ||
    typeof value.performedExerciseId !== "string" ||
    !UUID_PATTERN.test(value.performedExerciseId) ||
    value.performedSemanticsVersion !== 1 ||
    typeof value.performedLoadType !== "string" ||
    value.performedLoadType.trim().length === 0 ||
    value.performedLoadType.length > 50 ||
    !isPerformedLoadSemantics(value.performedLoadSemantics)
  ) {
    return false;
  }
  const weight = value.weight === null || typeof value.weight === "number"
    ? value.weight
    : undefined;
  const weightUnit = value.weightUnit === null ||
      value.weightUnit === "lb" || value.weightUnit === "kg"
    ? value.weightUnit
    : undefined;
  const reps = value.reps === null || typeof value.reps === "number"
    ? value.reps
    : undefined;
  const distanceKm = value.distanceKm === null || typeof value.distanceKm === "number"
    ? value.distanceKm
    : undefined;
  const durationSeconds = value.durationSeconds === null ||
      typeof value.durationSeconds === "number"
    ? value.durationSeconds
    : undefined;
  if (
    weight === undefined || weightUnit === undefined || reps === undefined ||
    distanceKm === undefined || durationSeconds === undefined ||
    !isNullableNumber(weight, 0, 2000) ||
    !isNullableNumber(reps, 0, 100) ||
    (reps != null && !Number.isInteger(reps)) ||
    !isNullableNumber(distanceKm, 0, 10_000) ||
    !isNullableNumber(durationSeconds, 0, 604_800) ||
    (durationSeconds != null && !Number.isInteger(durationSeconds)) ||
    !validateSetWriterShape({
      metricType: value.metricType as PerformedMetricType,
      loadSemantics: value.performedLoadSemantics,
      weight,
      weightUnit,
      reps,
      distanceKm,
      durationSeconds,
    }).ok
  ) {
    return false;
  }
  return (
    typeof value.clientKey === "string" &&
    UUID_PATTERN.test(value.clientKey) &&
    typeof value.ownerId === "string" &&
    UUID_PATTERN.test(value.ownerId) &&
    typeof value.sessionId === "string" &&
    UUID_PATTERN.test(value.sessionId) &&
    typeof value.sessionExerciseId === "string" &&
    UUID_PATTERN.test(value.sessionExerciseId) &&
    (value.occurrenceId === undefined || (
      typeof value.occurrenceId === "string" && UUID_PATTERN.test(value.occurrenceId)
    )) &&
    (value.expectedOccurrenceRevision === undefined || (
      Number.isInteger(value.expectedOccurrenceRevision) &&
      Number(value.expectedOccurrenceRevision) >= 0
    )) &&
    ((value.occurrenceId === undefined) ===
      (value.expectedOccurrenceRevision === undefined)) &&
    (value.workoutName === undefined ||
      (typeof value.workoutName === "string" &&
        value.workoutName.length > 0 &&
        value.workoutName.length <= 200)) &&
    typeof value.exerciseName === "string" &&
    value.exerciseName.length > 0 &&
    value.exerciseName.length <= 200 &&
    typeof value.setNo === "number" &&
    Number.isInteger(value.setNo) &&
    value.setNo >= 1 &&
    value.setNo <= 50 &&
    isNullableNumber(value.rpe, 1, 10) &&
    isNullableNumber(value.rir, 0, 10) &&
    (value.rpe === null || value.rir === null) &&
    (value.techniqueIssue === null ||
      TECHNIQUE_ISSUES.includes(value.techniqueIssue as TechniqueIssue)) &&
    (value.limitationCause === null ||
      LIMITATION_CAUSES.includes(value.limitationCause as LimitationCause)) &&
    (value.pain === null || (
      isRecord(value.pain) &&
      PAIN_BODY_PARTS.includes(value.pain.bodyPart as SetPainContext["bodyPart"]) &&
      Number.isInteger(value.pain.severity) &&
      Number(value.pain.severity) >= 1 &&
      Number(value.pain.severity) <= 10 &&
      (value.pain.note === null ||
        (typeof value.pain.note === "string" && value.pain.note.length <= 500))
    )) &&
    (value.note === null ||
      (typeof value.note === "string" && value.note.length <= 500)) &&
    isDate(value.createdAtISO) &&
    (value.status === "queued" || value.status === "needs_attention") &&
    typeof value.attemptCount === "number" &&
    Number.isInteger(value.attemptCount) &&
    value.attemptCount >= 0 &&
    isNullableDate(value.nextAttemptAtISO) &&
    isNullableDate(value.lastAttemptAtISO) &&
    (value.lastError === null ||
      (typeof value.lastError === "string" && value.lastError.length <= 500)) &&
    (value.orderBlocker === undefined || value.orderBlocker === null ||
      isWorkoutSetOrderBlocker(value.orderBlocker)) &&
    (value.reviewRequired === undefined || value.reviewRequired === null ||
      value.reviewRequired === "stale_occurrence") &&
    (value.equipmentSnapshotId === null ||
      (typeof value.equipmentSnapshotId === "string" &&
        UUID_PATTERN.test(value.equipmentSnapshotId))) &&
    (value.equipmentSelectionClientKey === undefined ||
      value.equipmentSelectionClientKey === null ||
      (typeof value.equipmentSelectionClientKey === "string" &&
        UUID_PATTERN.test(value.equipmentSelectionClientKey))) &&
    (value.restAfterSec === undefined || value.restAfterSec === null ||
      (Number.isInteger(value.restAfterSec) &&
        Number(value.restAfterSec) >= 0 && Number(value.restAfterSec) <= 1800)) &&
    isWorkoutSetLoadEntryMeaning(value.loadEntryMeaning) &&
    isNullableDate(value.observedCompletedAtISO) &&
    (value.equipmentSelectionClientKey != null
      ? value.loadEntryMeaning !== "legacy_unknown"
      : ((value.equipmentSnapshotId === null &&
          value.loadEntryMeaning === "legacy_unknown") ||
        (value.equipmentSnapshotId !== null &&
          value.loadEntryMeaning !== "legacy_unknown")))
  );
}

function isStoredQuarantinedEntry(
  value: unknown
): value is StoredQuarantinedWorkoutSetOutboxEntry {
  return (
    isRecord(value) &&
    value.quarantine === "workout-set-outbox-entry-v1" &&
    "raw" in value &&
    WORKOUT_SET_QUARANTINE_REASONS.includes(
      value.reason as WorkoutSetQuarantineReason
    )
  );
}

function ordered(entries: WorkoutSetOutboxEntry[]) {
  return [...entries].sort(
    (a, b) =>
      Date.parse(a.createdAtISO) - Date.parse(b.createdAtISO) ||
      a.clientKey.localeCompare(b.clientKey)
  );
}

function compareWorkoutRestIntentOrder(
  left: Pick<WorkoutRestIntentReceipt, "clientKey" | "createdAtISO">,
  right: Pick<WorkoutRestIntentReceipt, "clientKey" | "createdAtISO">,
) {
  return Date.parse(left.createdAtISO) - Date.parse(right.createdAtISO) ||
    left.clientKey.localeCompare(right.clientKey);
}

function isWorkoutRestIntentReceipt(
  value: unknown,
): value is WorkoutRestIntentReceipt {
  return isRecord(value) &&
    typeof value.clientKey === "string" && UUID_PATTERN.test(value.clientKey) &&
    typeof value.ownerId === "string" && UUID_PATTERN.test(value.ownerId) &&
    typeof value.sessionId === "string" && UUID_PATTERN.test(value.sessionId) &&
    isDate(value.createdAtISO) &&
    (value.restAfterSec === null ||
      (Number.isInteger(value.restAfterSec) &&
        Number(value.restAfterSec) >= 0 &&
        Number(value.restAfterSec) <= 1800));
}

function readWorkoutRestIntentReceiptEntries(
  storage: WorkoutSetOutboxStorage,
) {
  try {
    const raw = storage.getItem(WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY);
    if (raw == null) {
      return { ok: true as const, entries: [] as WorkoutRestIntentReceipt[] };
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) || parsed.version !== 1 ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.length > MAX_WORKOUT_REST_INTENT_RECEIPTS ||
      !parsed.entries.every(isWorkoutRestIntentReceipt)
    ) {
      return {
        ok: false as const,
        reason: "The saved workout rest decision record could not be read.",
      };
    }
    const identities = new Set<string>();
    for (const entry of parsed.entries) {
      const identity = `${entry.ownerId}:${entry.sessionId}`;
      if (identities.has(identity)) {
        return {
          ok: false as const,
          reason: "The saved workout rest decision record was ambiguous.",
        };
      }
      identities.add(identity);
    }
    return {
      ok: true as const,
      entries: parsed.entries as WorkoutRestIntentReceipt[],
    };
  } catch {
    return {
      ok: false as const,
      reason: "This browser could not open the saved workout rest decision record.",
    };
  }
}

function writeWorkoutRestIntentReceiptEntries(
  storage: WorkoutSetOutboxStorage,
  entries: WorkoutRestIntentReceipt[],
) {
  storage.setItem(
    WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY,
    JSON.stringify({ version: 1, entries }),
  );
}

type WorkoutStorageCleanupSnapshot = {
  outboxRaw: string | null;
  restIntentReceiptsRaw: string | null;
};

function readWorkoutStorageCleanupSnapshot(
  storage: WorkoutSetOutboxStorage,
): WorkoutStorageCleanupSnapshot | null {
  try {
    return {
      outboxRaw: storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY),
      restIntentReceiptsRaw: storage.getItem(
        WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY,
      ),
    };
  } catch {
    return null;
  }
}

function restoreStorageRaw(
  storage: WorkoutSetOutboxStorage,
  key: string,
  raw: string | null,
) {
  try {
    if (storage.getItem(key) === raw) return true;
    if (raw == null) {
      const removable = storage as WorkoutSetOutboxStorage & {
        removeItem?: (storageKey: string) => void;
      };
      if (typeof removable.removeItem !== "function") return false;
      removable.removeItem(key);
    } else {
      storage.setItem(key, raw);
    }
    return storage.getItem(key) === raw;
  } catch {
    return false;
  }
}

function restoreWorkoutStorageCleanupSnapshot(
  storage: WorkoutSetOutboxStorage,
  snapshot: WorkoutStorageCleanupSnapshot,
) {
  const outboxRestored = restoreStorageRaw(
    storage,
    WORKOUT_SET_OUTBOX_STORAGE_KEY,
    snapshot.outboxRaw,
  );
  const receiptsRestored = restoreStorageRaw(
    storage,
    WORKOUT_REST_INTENT_RECEIPTS_STORAGE_KEY,
    snapshot.restIntentReceiptsRaw,
  );
  return outboxRestored && receiptsRestored;
}

export function getWorkoutRestIntentReceipt(
  storage: WorkoutSetOutboxStorage,
  identity: Pick<WorkoutRestIntentReceipt, "ownerId" | "sessionId">,
) {
  const current = readWorkoutRestIntentReceiptEntries(storage);
  if (!current.ok) return current;
  return {
    ok: true as const,
    receipt: current.entries.find(
      (entry) =>
        entry.ownerId === identity.ownerId &&
        entry.sessionId === identity.sessionId,
    ) ?? null,
  };
}

export function workoutRestIntentReceiptSupersedesEntry(
  receipt: WorkoutRestIntentReceipt | null,
  entry: Pick<
    WorkoutSetOutboxEntry,
    "clientKey" | "ownerId" | "sessionId" | "createdAtISO"
  >,
) {
  return receipt != null &&
    receipt.ownerId === entry.ownerId &&
    receipt.sessionId === entry.sessionId &&
    compareWorkoutRestIntentOrder(receipt, entry) > 0;
}

/**
 * Advances the latest acknowledged rest decision monotonically. Callers must
 * not record an unsent set command: retained intent already lives in the outbox.
 * A deliberate device-only rest (such as Add extra set) is acknowledged locally
 * and may use its stable timer generation as the receipt identity. This receipt
 * never represents or creates a performed set.
 */
export function recordWorkoutRestIntentReceipt(
  storage: WorkoutSetOutboxStorage,
  entry: Pick<
    WorkoutSetOutboxEntry,
    | "clientKey"
    | "ownerId"
    | "sessionId"
    | "createdAtISO"
    | "restAfterSec"
  >,
) {
  const candidate: WorkoutRestIntentReceipt = {
    clientKey: entry.clientKey,
    ownerId: entry.ownerId,
    sessionId: entry.sessionId,
    createdAtISO: entry.createdAtISO,
    restAfterSec: entry.restAfterSec ?? null,
  };
  if (entry.restAfterSec === undefined || !isWorkoutRestIntentReceipt(candidate)) {
    return {
      ok: false as const,
      reason: "The workout rest decision could not be retained safely.",
    };
  }
  const current = readWorkoutRestIntentReceiptEntries(storage);
  if (!current.ok) return current;
  const existing = current.entries.find(
    (receipt) =>
      receipt.ownerId === candidate.ownerId &&
      receipt.sessionId === candidate.sessionId,
  );
  if (existing && compareWorkoutRestIntentOrder(existing, candidate) >= 0) {
    return { ok: true as const, receipt: existing };
  }
  const entries = current.entries.filter(
    (receipt) =>
      receipt.ownerId !== candidate.ownerId ||
      receipt.sessionId !== candidate.sessionId,
  );
  try {
    writeWorkoutRestIntentReceiptEntries(
      storage,
      [...entries, candidate].slice(-MAX_WORKOUT_REST_INTENT_RECEIPTS),
    );
    return { ok: true as const, receipt: candidate };
  } catch {
    return {
      ok: false as const,
      reason: "This browser could not retain the workout rest decision.",
    };
  }
}

/**
 * Drops receipts only after no older explicit rest command from that workout
 * can replay. A stale receipt is conservative, so cleanup failure never makes
 * an acknowledged command unsafe to remove.
 */
export function pruneWorkoutRestIntentReceipts(
  storage: WorkoutSetOutboxStorage,
) {
  const receipts = readWorkoutRestIntentReceiptEntries(storage);
  if (!receipts.ok) return receipts;
  const outbox = readWorkoutSetOutbox(storage);
  if (outbox.error) return { ok: false as const, reason: outbox.error };
  const retained = receipts.entries.filter((receipt) =>
    outbox.entries.some(
      (entry) =>
        entry.ownerId === receipt.ownerId &&
        entry.sessionId === receipt.sessionId &&
        entry.restAfterSec !== undefined &&
        compareWorkoutRestIntentOrder(entry, receipt) <= 0,
    )
  );
  if (retained.length === receipts.entries.length) {
    return { ok: true as const };
  }
  try {
    writeWorkoutRestIntentReceiptEntries(storage, retained);
    return { ok: true as const };
  } catch {
    return {
      ok: false as const,
      reason: "This browser could not clean up saved workout rest decisions.",
    };
  }
}

export function removeWorkoutRestIntentReceiptsForOwner(
  storage: WorkoutSetOutboxStorage,
  ownerId: string,
) {
  const receipts = readWorkoutRestIntentReceiptEntries(storage);
  if (!receipts.ok) return receipts;
  if (!receipts.entries.some((entry) => entry.ownerId === ownerId)) {
    return { ok: true as const };
  }
  try {
    writeWorkoutRestIntentReceiptEntries(
      storage,
      receipts.entries.filter((entry) => entry.ownerId !== ownerId),
    );
    return { ok: true as const };
  } catch {
    return {
      ok: false as const,
      reason: "This browser could not clean up saved workout rest decisions.",
    };
  }
}

/**
 * Returns the durable rest intents retained after an exact queued set in this
 * workout. The queued command itself is the client-key-bound tombstone: an
 * explicit later zero/null rest must keep an older acknowledgement from
 * recreating a timer that the athlete has already superseded.
 */
export function laterWorkoutSetRestIntentClientKeys(
  entries: readonly WorkoutSetOutboxEntry[],
  anchor: Pick<
    WorkoutSetOutboxEntry,
    "clientKey" | "ownerId" | "sessionId"
  >,
) {
  const sessionEntries = ordered(
    entries.filter((entry) =>
      entry.ownerId === anchor.ownerId && entry.sessionId === anchor.sessionId
    ),
  );
  const anchorIndex = sessionEntries.findIndex(
    (entry) => entry.clientKey === anchor.clientKey,
  );
  if (anchorIndex < 0) return [];
  return sessionEntries
    .slice(anchorIndex + 1)
    .filter((entry) => entry.restAfterSec !== undefined)
    .map((entry) => entry.clientKey);
}

export function parseWorkoutSetOutbox(raw: string | null): WorkoutSetOutboxSnapshot {
  if (raw == null || raw === "") return EMPTY_SNAPSHOT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      entries: [],
      quarantined: [],
      error:
        "The saved workout set queue on this device could not be read. It was left unchanged.",
    };
  }
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2 &&
      value.version !== 3 && value.version !== 4) ||
    !Array.isArray(value.entries)
  ) {
    return {
      entries: [],
      quarantined: [],
      error:
        "The saved workout set queue uses an unsupported format. It was left unchanged.",
    };
  }
  const entries: WorkoutSetOutboxEntry[] = [];
  const quarantined: QuarantinedWorkoutSetOutboxEntry[] = [];
  const identities = new Set<string>();
  const slots = new Set<string>();
  for (const [sourceIndex, raw] of value.entries.entries()) {
    if (isStoredQuarantinedEntry(raw)) {
      quarantined.push({
        quarantineKey: `quarantined:${sourceIndex}`,
        raw: raw.raw,
        reason: raw.reason,
      });
      continue;
    }
    if (value.version !== 4) {
      quarantined.push({
        quarantineKey: `entries:${sourceIndex}`,
        raw,
        reason:
          "This saved workout set uses an older recording format and needs review.",
      });
      continue;
    }
    const migrated = isRecord(raw)
      ? {
          ...raw,
          rir: raw.rir ?? null,
          techniqueIssue: raw.techniqueIssue ?? null,
          limitationCause: raw.limitationCause ?? null,
          pain: raw.pain ?? null,
        }
      : raw;
    if (!isWorkoutSetOutboxEntry(migrated)) {
      quarantined.push({
        quarantineKey: `entries:${sourceIndex}`,
        raw,
        reason: "This saved workout set is incomplete or invalid.",
      });
      continue;
    }
    const slot = `${migrated.sessionExerciseId}:${migrated.setNo}`;
    if (identities.has(migrated.clientKey)) {
      quarantined.push({
        quarantineKey: `entries:${sourceIndex}`,
        raw,
        reason: "This saved workout set repeats an earlier identity.",
      });
      continue;
    }
    if (slots.has(slot)) {
      quarantined.push({
        quarantineKey: `entries:${sourceIndex}`,
        raw,
        reason: "This saved workout set repeats an earlier set number.",
      });
      continue;
    }
    identities.add(migrated.clientKey);
    slots.add(slot);
    entries.push(migrated);
  }
  return { entries: ordered(entries), quarantined, error: null };
}

export function readWorkoutSetOutbox(
  storage: WorkoutSetOutboxStorage
): WorkoutSetOutboxSnapshot {
  try {
    return parseWorkoutSetOutbox(storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY));
  } catch {
    return {
      entries: [],
      quarantined: [],
      error: "This browser would not open the saved workout set queue.",
    };
  }
}

function writeWorkoutSetOutbox(
  storage: WorkoutSetOutboxStorage,
  entries: WorkoutSetOutboxEntry[],
  quarantined: QuarantinedWorkoutSetOutboxEntry[]
) {
  const envelope: OutboxEnvelope = {
    version: 4,
    entries: [
      ...ordered(entries),
      ...quarantined.map(({ raw, reason }) => ({
        quarantine: "workout-set-outbox-entry-v1" as const,
        raw,
        reason,
      })),
    ],
  };
  storage.setItem(WORKOUT_SET_OUTBOX_STORAGE_KEY, JSON.stringify(envelope));
}

function sameSet(
  entry: WorkoutSetOutboxEntry,
  input: NewWorkoutSetOutboxEntry
) {
  return (
    entry.ownerId === input.ownerId &&
    entry.sessionId === input.sessionId &&
    entry.sessionExerciseId === input.sessionExerciseId &&
    (entry.occurrenceId ?? null) === (input.occurrenceId ?? null) &&
    (entry.expectedOccurrenceRevision ?? null) ===
      (input.expectedOccurrenceRevision ?? null) &&
    entry.performedExerciseId === input.performedExerciseId &&
    entry.performedSemanticsVersion === input.performedSemanticsVersion &&
    entry.performedLoadType === input.performedLoadType &&
    entry.performedLoadSemantics === input.performedLoadSemantics &&
    entry.setNo === input.setNo &&
    entry.metricType === input.metricType &&
    entry.weight === input.weight &&
    entry.weightUnit === input.weightUnit &&
    entry.reps === input.reps &&
    entry.distanceKm === input.distanceKm &&
    entry.durationSeconds === input.durationSeconds &&
    entry.rpe === input.rpe &&
    entry.rir === (input.rir ?? null) &&
    entry.techniqueIssue === (input.techniqueIssue ?? null) &&
    entry.limitationCause === (input.limitationCause ?? null) &&
    hasSameRawValue(entry.pain, input.pain ?? null) &&
    entry.note === input.note
    && entry.equipmentSnapshotId === input.equipmentSnapshotId
    && (entry.equipmentSelectionClientKey ?? null) ===
      (input.equipmentSelectionClientKey ?? null)
    && entry.restAfterSec === input.restAfterSec
    && entry.loadEntryMeaning === input.loadEntryMeaning
    && entry.observedCompletedAtISO === (input.observedCompletedAtISO ?? null)
  );
}

export function enqueueWorkoutSetOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  input: NewWorkoutSetOutboxEntry,
  requireResolvableEquipmentDependency = false,
): MutationResult {
  const resolvedInput = resolveAcknowledgedEquipmentDependency(
    storage,
    input,
    requireResolvableEquipmentDependency,
  );
  if ("reason" in resolvedInput) return { ok: false, reason: resolvedInput.reason };
  input = resolvedInput;
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const existing = current.entries.find((entry) => entry.clientKey === input.clientKey);
  if (existing) {
    return sameSet(existing, input)
      ? { ok: true, entry: existing }
      : {
          ok: false,
          reason: "That saved set identity already belongs to different values.",
        };
  }
  if (
    current.entries.some(
      (entry) =>
        entry.sessionExerciseId === input.sessionExerciseId &&
        entry.setNo === input.setNo
    )
  ) {
    return {
      ok: false,
      reason: "That set number is already waiting to be saved on this device.",
    };
  }
  if (
    current.entries.length + current.quarantined.length >=
    WORKOUT_SET_OUTBOX_MAX_ENTRIES
  ) {
    return {
      ok: false,
      reason:
        "The workout set queue is full. Retry or remove an older unsaved set first.",
    };
  }
  const entry: WorkoutSetOutboxEntry = {
    ...input,
    rir: input.rir ?? null,
    techniqueIssue: input.techniqueIssue ?? null,
    limitationCause: input.limitationCause ?? null,
    pain: input.pain ?? null,
    observedCompletedAtISO: input.observedCompletedAtISO ?? null,
    status: "queued",
    attemptCount: 0,
    nextAttemptAtISO: null,
    lastAttemptAtISO: null,
    lastError: null,
  };
  if (!isWorkoutSetOutboxEntry(entry)) {
    return { ok: false, reason: "The set could not be prepared for device storage." };
  }
  try {
    writeWorkoutSetOutbox(storage, [...current.entries, entry], current.quarantined);
    return { ok: true, entry };
  } catch {
    return {
      ok: false,
      reason:
        "This browser could not retain the set safely. The set was not logged.",
    };
  }
}

function replaceEntry(
  storage: WorkoutSetOutboxStorage,
  clientKey: string,
  replacement: (entry: WorkoutSetOutboxEntry) => WorkoutSetOutboxEntry
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const index = current.entries.findIndex((entry) => entry.clientKey === clientKey);
  if (index < 0) return { ok: true, entry: null };
  const entry = replacement(current.entries[index]);
  if (!isWorkoutSetOutboxEntry(entry)) {
    return { ok: false, reason: "The saved workout set update was invalid." };
  }
  const entries = [...current.entries];
  entries[index] = entry;
  try {
    writeWorkoutSetOutbox(storage, entries, current.quarantined);
    return { ok: true, entry };
  } catch {
    return { ok: false, reason: "This browser could not update the saved set." };
  }
}

export function markWorkoutSetTransientFailure(
  storage: WorkoutSetOutboxStorage,
  clientKey: string,
  reason: string,
  now = new Date()
): MutationResult {
  return replaceEntry(storage, clientKey, (entry) => {
    const attemptCount = entry.attemptCount + 1;
    const paused = attemptCount >= WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS;
    return {
      ...entry,
      status: paused ? "needs_attention" : "queued",
      attemptCount,
      lastAttemptAtISO: now.toISOString(),
      nextAttemptAtISO: paused
        ? null
        : new Date(now.getTime() + nextWorkoutSetRetryDelayMs(attemptCount)).toISOString(),
      lastError: paused
        ? "Automatic retry paused after repeated connection failures."
        : reason.slice(0, 500),
    };
  });
}

export function markWorkoutSetNeedsAttention(
  storage: WorkoutSetOutboxStorage,
  clientKey: string,
  reason: string,
  now = new Date(),
  orderBlocker: WorkoutSetOrderBlocker | null = null,
  reviewRequired: WorkoutSetOutboxEntry["reviewRequired"] = null,
): MutationResult {
  return replaceEntry(storage, clientKey, (entry) => ({
    ...entry,
    status: "needs_attention",
    attemptCount: entry.attemptCount + 1,
    nextAttemptAtISO: null,
    lastAttemptAtISO: now.toISOString(),
    lastError: reason.slice(0, 500),
    orderBlocker,
    reviewRequired,
  }));
}

export function retryWorkoutSetOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  clientKey: string
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const blocked = current.entries.find((entry) => entry.clientKey === clientKey);
  if (blocked?.orderBlocker) {
    return {
      ok: false,
      reason: `Resolve ${blocked.orderBlocker.label} before retrying this saved attempt.`,
    };
  }
  if (blocked?.reviewRequired === "stale_occurrence") {
    return {
      ok: false,
      reason: "Refresh the workout and review or discard this retained attempt before retrying.",
    };
  }
  return replaceEntry(storage, clientKey, (entry) => ({
    ...entry,
    status: "queued",
    attemptCount: 0,
    nextAttemptAtISO: null,
    lastError: null,
  }));
}

export function releaseWorkoutSetOrderBlockerOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  clientKey: string,
  blockerOccurrenceId: string,
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const blocked = current.entries.find((entry) => entry.clientKey === clientKey);
  if (!blocked) return { ok: true, entry: null };
  if (blocked.orderBlocker?.occurrenceId !== blockerOccurrenceId) {
    return {
      ok: false,
      reason: "The saved attempt's required earlier set changed. Refresh before retrying.",
    };
  }
  return replaceEntry(storage, clientKey, (entry) => ({
    ...entry,
    status: "queued",
    attemptCount: 0,
    nextAttemptAtISO: null,
    lastError: null,
    orderBlocker: null,
    reviewRequired: null,
  }));
}

export function releaseQueuedWorkoutSetBackoffForOwner(
  storage: WorkoutSetOutboxStorage,
  ownerId: string
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entries = current.entries.map((entry) =>
    entry.ownerId === ownerId && entry.status === "queued"
      ? { ...entry, nextAttemptAtISO: null }
      : entry
  );
  try {
    writeWorkoutSetOutbox(storage, entries, current.quarantined);
    return { ok: true, entry: null };
  } catch {
    return {
      ok: false,
      reason: "This browser could not release the saved set retry delay.",
    };
  }
}

export function removeWorkoutSetOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  clientKey: string
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  const cleanupSnapshot = readWorkoutStorageCleanupSnapshot(storage);
  if (!cleanupSnapshot) {
    return {
      ok: false,
      reason: "This browser could not safely open the saved set for removal.",
    };
  }
  try {
    writeWorkoutSetOutbox(
      storage,
      current.entries.filter((item) => item.clientKey !== clientKey),
      current.quarantined
    );
    const pruned = pruneWorkoutRestIntentReceipts(storage);
    if (!pruned.ok) {
      const restored = restoreWorkoutStorageCleanupSnapshot(
        storage,
        cleanupSnapshot,
      );
      return {
        ok: false,
        reason: restored
          ? `${pruned.reason} The saved set was restored on this device.`
          : "Repbook could not restore the saved set after its rest decision cleanup failed. Keep this workout open and review the device-copy tray.",
      };
    }
    return { ok: true, entry };
  } catch {
    restoreWorkoutStorageCleanupSnapshot(storage, cleanupSnapshot);
    return { ok: false, reason: "This browser could not remove the saved set." };
  }
}

export function removeWorkoutSetOutboxEntryForOwner(
  storage: WorkoutSetOutboxStorage,
  ownerId: string,
  clientKey: string
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  if (entry.ownerId !== ownerId) {
    return {
      ok: false,
      reason: "The saved set now belongs to a different account.",
    };
  }
  return removeWorkoutSetOutboxEntry(storage, clientKey);
}

export function removeWorkoutSetOutboxEntryForSession(
  storage: WorkoutSetOutboxStorage,
  ownerId: string,
  sessionId: string,
  clientKey: string,
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) {
    return {
      ok: false,
      reason: "The saved set changed before this workout could be discarded.",
    };
  }
  if (entry.ownerId !== ownerId || entry.sessionId !== sessionId) {
    return {
      ok: false,
      reason: "The saved set now belongs to a different workout or account.",
    };
  }
  return removeWorkoutSetOutboxEntry(storage, clientKey);
}

export function removeWorkoutSetOutboxEntriesForOwner(
  storage: WorkoutSetOutboxStorage,
  ownerId: string
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const owned = current.entries.filter((entry) => entry.ownerId === ownerId);
  if (owned.length === 0) {
    const cleaned = removeWorkoutRestIntentReceiptsForOwner(storage, ownerId);
    return cleaned.ok ? { ok: true, entry: null } : cleaned;
  }
  const cleanupSnapshot = readWorkoutStorageCleanupSnapshot(storage);
  if (!cleanupSnapshot) {
    return {
      ok: false,
      reason: "This browser could not safely open the saved workout sets for removal.",
    };
  }
  try {
    writeWorkoutSetOutbox(
      storage,
      current.entries.filter((entry) => entry.ownerId !== ownerId),
      current.quarantined
    );
    const cleaned = removeWorkoutRestIntentReceiptsForOwner(storage, ownerId);
    if (!cleaned.ok) {
      const restored = restoreWorkoutStorageCleanupSnapshot(
        storage,
        cleanupSnapshot,
      );
      return {
        ok: false,
        reason: restored
          ? `${cleaned.reason} The saved workout sets were restored on this device.`
          : "Repbook could not restore the saved workout sets after their rest decision cleanup failed. Review the device-copy tray before signing out.",
      };
    }
    return { ok: true, entry: owned[0] };
  } catch {
    restoreWorkoutStorageCleanupSnapshot(storage, cleanupSnapshot);
    return {
      ok: false,
      reason: "This browser could not remove the saved workout sets.",
    };
  }
}

export function discardQuarantinedWorkoutSetOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  quarantineKey: string,
  expectedRaw: unknown
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const selected = current.quarantined.find(
    (item) => item.quarantineKey === quarantineKey
  );
  if (!selected || !hasSameRawValue(selected.raw, expectedRaw)) {
    return {
      ok: false,
      reason: "The quarantined saved set changed before it could be discarded.",
    };
  }
  try {
    writeWorkoutSetOutbox(
      storage,
      current.entries,
      current.quarantined.filter(
        (item) => item.quarantineKey !== quarantineKey
      )
    );
    return { ok: true, entry: null };
  } catch {
    return {
      ok: false,
      reason: "This browser could not discard the quarantined saved set.",
    };
  }
}

export function nextWorkoutSetOutboxEntry(
  entries: WorkoutSetOutboxEntry[],
  ownerId: string,
  now = new Date()
) {
  const blocked = new Map<string, WorkoutSetOutboxEntry>();
  for (const entry of ordered(entries)) {
    if (entry.ownerId !== ownerId) {
      continue;
    }
    const blockingEntry = blocked.get(entry.sessionExerciseId);
    const resolvesExactBlocker =
      blockingEntry?.orderBlocker != null &&
      entry.occurrenceId === blockingEntry.orderBlocker.occurrenceId;
    if (blockingEntry && !resolvesExactBlocker) continue;
    if (
      entry.status === "queued" &&
      entry.equipmentSelectionClientKey == null &&
      (!entry.nextAttemptAtISO ||
        Date.parse(entry.nextAttemptAtISO) <= now.getTime())
    ) {
      return entry;
    }
    if (!resolvesExactBlocker) {
      blocked.set(entry.sessionExerciseId, entry);
    }
  }
  return null;
}

/**
 * Binds every dependent set to the immutable snapshot acknowledged for its
 * selection command. The caller holds the shared browser outbox lock.
 */
export function bindWorkoutSetsToEquipmentSelectionUnlocked(
  selectionClientKey: string,
  snapshotId: string | null,
  occurrenceStates: ReadonlyArray<{ id: string; revision: number }> = [],
) {
  return unlockedBrowserMutation((storage) =>
    bindWorkoutSetEntriesToEquipmentSelection(
      storage,
      selectionClientKey,
      snapshotId,
      occurrenceStates,
    )
  );
}

export function bindWorkoutSetEntriesToEquipmentSelection(
  storage: WorkoutSetOutboxStorage,
  selectionClientKey: string,
  snapshotId: string | null,
  occurrenceStates: ReadonlyArray<{ id: string; revision: number }> = [],
) {
    const current = readWorkoutSetOutbox(storage);
    if (current.error) return { ok: false as const, reason: current.error };
    const dependents = current.entries.filter(
      (entry) => entry.equipmentSelectionClientKey === selectionClientKey,
    );
    if (dependents.length === 0) return { ok: true as const, entry: null };
    if (snapshotId == null) {
      return {
        ok: false as const,
        reason: "The equipment command did not return a setup for its waiting sets.",
      };
    }
    const occurrenceRevisionById = new Map(
      occurrenceStates.map((state) => [state.id, state.revision]),
    );
    try {
      writeWorkoutSetOutbox(
        storage,
        current.entries.map((entry) =>
          entry.equipmentSelectionClientKey === selectionClientKey
            ? {
                ...entry,
                equipmentSelectionClientKey: null,
                equipmentSnapshotId: snapshotId,
                ...(entry.occurrenceId != null &&
                  occurrenceRevisionById.has(entry.occurrenceId)
                  ? {
                      expectedOccurrenceRevision:
                        occurrenceRevisionById.get(entry.occurrenceId)!,
                    }
                  : {}),
              }
            : entry,
        ),
        current.quarantined,
      );
      return { ok: true as const, entry: dependents[0] };
    } catch {
      return {
        ok: false as const,
        reason: "This browser could not bind waiting sets to their equipment setup.",
      };
    }
}

/** Shared, lock-protected monotonic ordering across selection and set writes. */
export function nextWorkoutCommandCreatedAt(
  storage: WorkoutSetOutboxStorage,
  now = Date.now(),
) {
  let previous = 0;
  try {
    const raw = storage.getItem(WORKOUT_COMMAND_SEQUENCE_KEY);
    if (raw != null) previous = Number.parseInt(raw, 10) || 0;
  } catch {
    // The following write remains authoritative and will report failure.
  }
  const value = Math.max(now, previous + 1);
  storage.setItem(WORKOUT_COMMAND_SEQUENCE_KEY, String(value));
  return new Date(value).toISOString();
}

export function nextWorkoutSetRetryDelayMs(attemptCount: number) {
  const delays = [1_000, 3_000, 10_000, 30_000, 120_000, 300_000];
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
}

function browserStorage(): WorkoutSetOutboxStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function notifyOutboxChange() {
  cachedRaw = undefined;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(WORKOUT_SET_OUTBOX_CHANGE_EVENT));
  }
}

function applyBrowserMutation(
  storage: WorkoutSetOutboxStorage,
  mutation: (storage: WorkoutSetOutboxStorage) => MutationResult
) {
  const result = mutation(storage);
  if (result.ok) notifyOutboxChange();
  return result;
}

export async function withOutboxLock<T>(
  task: () => T | Promise<T>
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      WORKOUT_SET_OUTBOX_LOCK_NAME,
      { mode: "exclusive" },
      task
    );
  }
  return task();
}

export function workoutCommandDeliveryLockName(ownerId: string) {
  return `${WORKOUT_COMMAND_DELIVERY_LOCK_PREFIX}:${encodeURIComponent(ownerId.toLowerCase())}`;
}

export function workoutCommandDeliveryLockSupported() {
  return typeof navigator !== "undefined" && navigator.locks != null;
}

/**
 * Keeps one owner's ordered equipment/set delivery single-flight without
 * holding the shared local-storage mutation lock across the network request.
 */
export async function withWorkoutCommandDeliveryLock<T>(
  ownerId: string,
  task: () => T | Promise<T>,
): Promise<T | null> {
  const lockName = workoutCommandDeliveryLockName(ownerId);
  if (workoutCommandDeliveryLockSupported()) {
    return navigator.locks.request(
      lockName,
      { mode: "exclusive" },
      task,
    );
  }

  // An in-memory promise chain cannot coordinate separate tabs. Keep durable
  // commands retained instead of risking duplicate or reordered delivery.
  return null;
}

async function browserMutation(
  mutation: (storage: WorkoutSetOutboxStorage) => MutationResult
) {
  const storage = browserStorage();
  if (!storage) {
    return {
      ok: false as const,
      reason: "This browser could not retain the set safely.",
    };
  }
  return withOutboxLock(() => applyBrowserMutation(storage, mutation));
}

function unlockedBrowserMutation(
  mutation: (storage: WorkoutSetOutboxStorage) => MutationResult
) {
  const storage = browserStorage();
  if (!storage) {
    return {
      ok: false as const,
      reason: "This browser could not retain the set safely.",
    };
  }
  return applyBrowserMutation(storage, mutation);
}

export function enqueueWorkoutSet(input: NewWorkoutSetOutboxEntry) {
  return browserMutation((storage) =>
    enqueueWorkoutSetOutboxEntry(storage, {
      ...input,
      createdAtISO: nextWorkoutCommandCreatedAt(storage),
    }, true)
  );
}

export function recordWorkoutSetTransientFailure(clientKey: string, reason: string) {
  return browserMutation((storage) =>
    markWorkoutSetTransientFailure(storage, clientKey, reason)
  );
}

export function recordWorkoutSetTransientFailureUnlocked(
  clientKey: string,
  reason: string
) {
  return unlockedBrowserMutation((storage) =>
    markWorkoutSetTransientFailure(storage, clientKey, reason)
  );
}

export function recordWorkoutSetNeedsAttention(clientKey: string, reason: string) {
  return browserMutation((storage) =>
    markWorkoutSetNeedsAttention(storage, clientKey, reason)
  );
}

export function recordWorkoutSetNeedsAttentionUnlocked(
  clientKey: string,
  reason: string,
  orderBlocker: WorkoutSetOrderBlocker | null = null,
  reviewRequired: WorkoutSetOutboxEntry["reviewRequired"] = null,
) {
  return unlockedBrowserMutation((storage) =>
    markWorkoutSetNeedsAttention(
      storage,
      clientKey,
      reason,
      new Date(),
      orderBlocker,
      reviewRequired,
    )
  );
}

export function retryWorkoutSet(clientKey: string) {
  return browserMutation((storage) => retryWorkoutSetOutboxEntry(storage, clientKey));
}

export function releaseWorkoutSetOrderBlocker(
  clientKey: string,
  blockerOccurrenceId: string,
) {
  return browserMutation((storage) =>
    releaseWorkoutSetOrderBlockerOutboxEntry(
      storage,
      clientKey,
      blockerOccurrenceId,
    )
  );
}

export function releaseWorkoutSetOrderBlockersForOccurrence(
  blockerOccurrenceId: string,
) {
  return browserMutation((storage) => {
    const current = readWorkoutSetOutbox(storage);
    if (current.error) return { ok: false, reason: current.error };
    const blockedEntries = current.entries.filter(
      (entry) => entry.orderBlocker?.occurrenceId === blockerOccurrenceId,
    );
    if (blockedEntries.length === 0) return { ok: true, entry: null };
    let lastReleased: WorkoutSetOutboxEntry | null = null;
    for (const entry of blockedEntries) {
      const released = releaseWorkoutSetOrderBlockerOutboxEntry(
        storage,
        entry.clientKey,
        blockerOccurrenceId,
      );
      if (!released.ok) return released;
      lastReleased = released.entry;
    }
    return { ok: true, entry: lastReleased };
  });
}

export function releaseQueuedWorkoutSetBackoff(ownerId: string) {
  return browserMutation((storage) =>
    releaseQueuedWorkoutSetBackoffForOwner(storage, ownerId)
  );
}

export function removeWorkoutSet(clientKey: string) {
  return browserMutation((storage) => removeWorkoutSetOutboxEntry(storage, clientKey));
}

const DISCARD_TIMER_FAILURE =
  "Repbook could not safely clear this set's rest timer. The set is still retained on this device; try again.";

export async function discardWorkoutSetDeviceCopy(
  storage: WorkoutSetOutboxStorage & RestTimerStorage,
  entry: Pick<
    WorkoutSetOutboxEntry,
    "clientKey" | "ownerId" | "sessionId"
  >,
) {
  return withOutboxLock(async () => {
    const cleared = await clearRestTimerForExactSourceClientKey(
      storage,
      { ownerId: entry.ownerId, sessionId: entry.sessionId },
      entry.clientKey,
    );
    if (cleared === "storage_error") {
      return { ok: false, reason: DISCARD_TIMER_FAILURE } as const;
    }
    return applyBrowserMutation(
      storage,
      (current) => removeWorkoutSetOutboxEntry(current, entry.clientKey),
    );
  });
}

export function removeWorkoutSetForOwner(ownerId: string, clientKey: string) {
  return browserMutation((storage) =>
    removeWorkoutSetOutboxEntryForOwner(storage, ownerId, clientKey)
  );
}

export function removeWorkoutSetUnlocked(clientKey: string) {
  return unlockedBrowserMutation((storage) =>
    removeWorkoutSetOutboxEntry(storage, clientKey)
  );
}

export function removeWorkoutSetsForOwner(ownerId: string) {
  return browserMutation((storage) =>
    removeWorkoutSetOutboxEntriesForOwner(storage, ownerId)
  );
}

export function discardQuarantinedWorkoutSet(
  quarantineKey: string,
  expectedRaw: unknown
) {
  return browserMutation((storage) =>
    discardQuarantinedWorkoutSetOutboxEntry(
      storage,
      quarantineKey,
      expectedRaw
    )
  );
}

export function getWorkoutSetOutboxSnapshot(): WorkoutSetOutboxSnapshot {
  const storage = browserStorage();
  if (!storage) return EMPTY_SNAPSHOT;
  let raw: string | null;
  try {
    raw = storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY);
  } catch {
    return {
      entries: [],
      quarantined: [],
      error: "This browser would not open the saved set queue.",
    };
  }
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;
  cachedSnapshot = parseWorkoutSetOutbox(raw);
  return cachedSnapshot;
}

export function getWorkoutSetOutboxServerSnapshot() {
  return EMPTY_SNAPSHOT;
}

export function subscribeToWorkoutSetOutbox(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === WORKOUT_SET_OUTBOX_STORAGE_KEY) {
      cachedRaw = undefined;
      onStoreChange();
    }
  };
  const onLocalChange = () => {
    cachedRaw = undefined;
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(WORKOUT_SET_OUTBOX_CHANGE_EVENT, onLocalChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(WORKOUT_SET_OUTBOX_CHANGE_EVENT, onLocalChange);
  };
}
