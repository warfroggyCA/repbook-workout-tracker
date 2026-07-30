import type { LoadUnit } from "@/lib/units";

export const WORKOUT_SET_OUTBOX_STORAGE_KEY =
  "workout-tracker:workout-set-outbox:v1";
export const WORKOUT_SET_OUTBOX_LOCK_NAME =
  "workout-tracker:workout-set-outbox";
const WORKOUT_COMMAND_SEQUENCE_KEY =
  "workout-tracker:workout-command-sequence:v1";
export const EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_STORAGE_KEY =
  "workout-tracker:equipment-selection-acknowledgements:v1";
export const WORKOUT_SET_OUTBOX_CHANGE_EVENT = "workout-set-outbox-change";
export const WORKOUT_SET_OUTBOX_STATUS_EVENT = "workout-set-outbox-status";
const WORKOUT_SET_OUTBOX_STATUS_CHANNEL = "workout-set-outbox-status-v1";
export const WORKOUT_SET_OUTBOX_MAX_ENTRIES = 100;
export const WORKOUT_SET_OUTBOX_MAX_AUTO_ATTEMPTS = 6;
const MAX_EQUIPMENT_SELECTION_ACKNOWLEDGEMENTS = 200;
const EQUIPMENT_SELECTION_ACKNOWLEDGEMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type EquipmentSelectionAcknowledgement = {
  clientKey: string;
  ownerId: string;
  sessionId: string;
  sessionExerciseId: string;
  snapshotId: string | null;
  acknowledgedAtISO: string;
};

export type WorkoutSetOutboxStatus = "queued" | "needs_attention";
export type WorkoutSetLoadEntryMeaning =
  | "total_system"
  | "per_loading_point"
  | "displayed_stack"
  | "per_stack"
  | "combined_stacks"
  | "legacy_unknown";

export type WorkoutSetOutboxEntry = {
  clientKey: string;
  ownerId: string;
  sessionId: string;
  sessionExerciseId: string;
  /** Human-readable workout context; older retained copies may not have it. */
  workoutName?: string;
  exerciseName: string;
  setNo: number;
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number;
  rpe: number | null;
  note: string | null;
  equipmentSnapshotId: string | null;
  /** Pending local selection that must be acknowledged before this set. */
  equipmentSelectionClientKey?: string | null;
  /** Rest guidance starts only after this exact set is acknowledged. */
  restAfterSec?: number;
  loadEntryMeaning: WorkoutSetLoadEntryMeaning;
  /**
   * Device-observed completion time frozen with the durable command. Older
   * retained commands are intentionally unknown rather than inferred.
   */
  observedCompletedAtISO: string | null;
  createdAtISO: string;
  status: WorkoutSetOutboxStatus;
  attemptCount: number;
  nextAttemptAtISO: string | null;
  lastAttemptAtISO: string | null;
  lastError: string | null;
};

export type NewWorkoutSetOutboxEntry = Omit<
  WorkoutSetOutboxEntry,
  | "status"
  | "attemptCount"
  | "nextAttemptAtISO"
  | "lastAttemptAtISO"
  | "lastError"
  | "observedCompletedAtISO"
> & { observedCompletedAtISO?: string | null };

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
      entry: WorkoutSetOutboxEntry;
    }
  | { type: "failed"; clientKey: string; sessionId: string }
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
  "This saved workout set repeats an earlier identity.",
  "This saved workout set repeats an earlier set number.",
] as const;
type WorkoutSetQuarantineReason =
  (typeof WORKOUT_SET_QUARANTINE_REASONS)[number];
type OutboxEnvelope = {
  version: 3;
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
  return {
    ...input,
    equipmentSelectionClientKey: null,
    equipmentSnapshotId: acknowledgement.snapshotId,
  };
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || isDate(value);
}

function isNullableNumber(value: unknown, min: number, max: number) {
  return value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}

function isLegacyWorkoutSetOutboxEntry(value: unknown): value is Record<
  string,
  unknown
> & Omit<WorkoutSetOutboxEntry, "equipmentSnapshotId" | "loadEntryMeaning" | "equipmentSelectionClientKey"> {
  if (!isRecord(value)) return false;
  const weighted = value.weight !== null;
  return (
    typeof value.clientKey === "string" &&
    UUID_PATTERN.test(value.clientKey) &&
    typeof value.ownerId === "string" &&
    UUID_PATTERN.test(value.ownerId) &&
    typeof value.sessionId === "string" &&
    UUID_PATTERN.test(value.sessionId) &&
    typeof value.sessionExerciseId === "string" &&
    UUID_PATTERN.test(value.sessionExerciseId) &&
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
    isNullableNumber(value.weight, 0, 2000) &&
    (weighted
      ? value.weightUnit === "lb" || value.weightUnit === "kg"
      : value.weightUnit === null) &&
    typeof value.reps === "number" &&
    Number.isInteger(value.reps) &&
    value.reps >= 0 &&
    value.reps <= 100 &&
    isNullableNumber(value.rpe, 1, 10) &&
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
      (typeof value.lastError === "string" && value.lastError.length <= 500))
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

function isWorkoutSetOutboxEntry(value: unknown): value is WorkoutSetOutboxEntry {
  return isLegacyWorkoutSetOutboxEntry(value) &&
    (value.equipmentSnapshotId === null ||
      (typeof value.equipmentSnapshotId === "string" &&
        UUID_PATTERN.test(value.equipmentSnapshotId))) &&
    (value.equipmentSelectionClientKey === undefined ||
      value.equipmentSelectionClientKey === null ||
      (typeof value.equipmentSelectionClientKey === "string" &&
        UUID_PATTERN.test(value.equipmentSelectionClientKey))) &&
    (value.restAfterSec === undefined ||
      (Number.isInteger(value.restAfterSec) &&
        Number(value.restAfterSec) >= 0 && Number(value.restAfterSec) <= 1800)) &&
    isWorkoutSetLoadEntryMeaning(value.loadEntryMeaning) &&
    isNullableDate(value.observedCompletedAtISO) &&
    (value.equipmentSelectionClientKey != null
      ? value.loadEntryMeaning !== "legacy_unknown"
      : ((value.equipmentSnapshotId === null &&
          value.loadEntryMeaning === "legacy_unknown") ||
        (value.equipmentSnapshotId !== null &&
          value.loadEntryMeaning !== "legacy_unknown")));
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
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
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
    const migrated =
      value.version === 1 && isLegacyWorkoutSetOutboxEntry(raw)
        ? {
            ...raw,
            equipmentSnapshotId: null,
            loadEntryMeaning: "legacy_unknown" as const,
            observedCompletedAtISO: null,
          }
        : value.version === 2 && isRecord(raw)
          ? { ...raw, observedCompletedAtISO: null }
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
    version: 3,
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
    entry.setNo === input.setNo &&
    entry.weight === input.weight &&
    entry.weightUnit === input.weightUnit &&
    entry.reps === input.reps &&
    entry.rpe === input.rpe &&
    entry.note === input.note
    && entry.equipmentSnapshotId === input.equipmentSnapshotId
    && (entry.equipmentSelectionClientKey ?? null) ===
      (input.equipmentSelectionClientKey ?? null)
    && (entry.restAfterSec ?? null) === (input.restAfterSec ?? null)
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
  now = new Date()
): MutationResult {
  return replaceEntry(storage, clientKey, (entry) => ({
    ...entry,
    status: "needs_attention",
    attemptCount: entry.attemptCount + 1,
    nextAttemptAtISO: null,
    lastAttemptAtISO: now.toISOString(),
    lastError: reason.slice(0, 500),
  }));
}

export function retryWorkoutSetOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  clientKey: string
): MutationResult {
  return replaceEntry(storage, clientKey, (entry) => ({
    ...entry,
    status: "queued",
    attemptCount: 0,
    nextAttemptAtISO: null,
    lastError: null,
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
  try {
    writeWorkoutSetOutbox(
      storage,
      current.entries.filter((item) => item.clientKey !== clientKey),
      current.quarantined
    );
    return { ok: true, entry };
  } catch {
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

export function removeWorkoutSetOutboxEntriesForOwner(
  storage: WorkoutSetOutboxStorage,
  ownerId: string
): MutationResult {
  const current = readWorkoutSetOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const owned = current.entries.filter((entry) => entry.ownerId === ownerId);
  if (owned.length === 0) return { ok: true, entry: null };
  try {
    writeWorkoutSetOutbox(
      storage,
      current.entries.filter((entry) => entry.ownerId !== ownerId),
      current.quarantined
    );
    return { ok: true, entry: owned[0] };
  } catch {
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
  const blocked = new Set<string>();
  for (const entry of ordered(entries)) {
    if (entry.ownerId !== ownerId || blocked.has(entry.sessionExerciseId)) {
      continue;
    }
    if (
      entry.status === "queued" &&
      entry.equipmentSelectionClientKey == null &&
      (!entry.nextAttemptAtISO ||
        Date.parse(entry.nextAttemptAtISO) <= now.getTime())
    ) {
      return entry;
    }
    blocked.add(entry.sessionExerciseId);
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
) {
  return unlockedBrowserMutation((storage) =>
    bindWorkoutSetEntriesToEquipmentSelection(storage, selectionClientKey, snapshotId)
  );
}

export function bindWorkoutSetEntriesToEquipmentSelection(
  storage: WorkoutSetOutboxStorage,
  selectionClientKey: string,
  snapshotId: string | null,
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
    try {
      writeWorkoutSetOutbox(
        storage,
        current.entries.map((entry) =>
          entry.equipmentSelectionClientKey === selectionClientKey
            ? {
                ...entry,
                equipmentSelectionClientKey: null,
                equipmentSnapshotId: snapshotId,
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
  reason: string
) {
  return unlockedBrowserMutation((storage) =>
    markWorkoutSetNeedsAttention(storage, clientKey, reason)
  );
}

export function retryWorkoutSet(clientKey: string) {
  return browserMutation((storage) => retryWorkoutSetOutboxEntry(storage, clientKey));
}

export function releaseQueuedWorkoutSetBackoff(ownerId: string) {
  return browserMutation((storage) =>
    releaseQueuedWorkoutSetBackoffForOwner(storage, ownerId)
  );
}

export function removeWorkoutSet(clientKey: string) {
  return browserMutation((storage) => removeWorkoutSetOutboxEntry(storage, clientKey));
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
