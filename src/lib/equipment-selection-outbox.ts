import {
  nextWorkoutCommandCreatedAt,
  readWorkoutSetOutbox,
  recordEquipmentSelectionAcknowledgement,
  withOutboxLock,
  type EquipmentSelectionOccurrenceAcknowledgement,
  type WorkoutSetOutboxEntry,
  type WorkoutSetOutboxStorage,
} from "@/lib/workout-set-outbox";

export const EQUIPMENT_SELECTION_OUTBOX_STORAGE_KEY =
  "workout-tracker:equipment-selection-outbox:v1";
export const EQUIPMENT_SELECTION_OUTBOX_CHANGE_EVENT =
  "equipment-selection-outbox-change";
export const EQUIPMENT_SELECTION_OUTBOX_STATUS_EVENT =
  "equipment-selection-outbox-status";
const STATUS_CHANNEL = "equipment-selection-outbox-status-v1";
const MAX_ENTRIES = 100;
const MAX_AUTO_ATTEMPTS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EquipmentSelectionOutboxStatus = "queued" | "needs_attention";
export type EquipmentSelectionOutboxEntry = {
  clientKey: string;
  ownerId: string;
  sessionId: string;
  sessionExerciseId: string;
  operation: "select" | "clear";
  equipmentItemId: string | null;
  attachmentItemId: string | null;
  expectedCurrentSnapshotId: string | null;
  predecessorSelectionClientKey: string | null;
  provenance: "auto_unique" | "user_selected" | null;
  equipmentLabel: string | null;
  attachmentLabel: string | null;
  createdAtISO: string;
  status: EquipmentSelectionOutboxStatus;
  attemptCount: number;
  nextAttemptAtISO: string | null;
  lastAttemptAtISO: string | null;
  lastError: string | null;
};

export type NewEquipmentSelectionOutboxEntry = Omit<
  EquipmentSelectionOutboxEntry,
  "createdAtISO" | "status" | "attemptCount" | "nextAttemptAtISO" |
    "lastAttemptAtISO" | "lastError"
>;

export type QuarantinedEquipmentSelection = {
  quarantineKey: string;
  raw: unknown;
  reason: string;
};

export type EquipmentSelectionOutboxSnapshot = {
  entries: EquipmentSelectionOutboxEntry[];
  quarantined: QuarantinedEquipmentSelection[];
  error: string | null;
};

export type EquipmentSelectionOutboxEvent =
  | { type: "saving"; clientKey: string; sessionExerciseId: string; retrying: boolean }
  | {
      type: "saved";
      clientKey: string;
      sessionExerciseId: string;
      snapshotId: string | null;
      occurrenceStates: Array<{
        id: string;
        outcome: string;
        outcomeReason: string | null;
        outcomeNote: string | null;
        revision: number;
        resolvedAt: string | null;
        completedSetId: string | null;
      }>;
    }
  | { type: "failed"; clientKey: string; sessionExerciseId: string };

type MutationResult =
  | { ok: true; entry: EquipmentSelectionOutboxEntry | null }
  | { ok: false; reason: string };

const EMPTY: EquipmentSelectionOutboxSnapshot = {
  entries: [], quarantined: [], error: null,
};
let cachedRaw: string | null | undefined;
let cachedSnapshot = EMPTY;
let channel: BroadcastChannel | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isNullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID.test(value));
}
function isEntry(value: unknown): value is EquipmentSelectionOutboxEntry {
  if (!isRecord(value)) return false;
  const selecting = value.operation === "select";
  return UUID.test(String(value.clientKey)) && UUID.test(String(value.ownerId)) &&
    UUID.test(String(value.sessionId)) && UUID.test(String(value.sessionExerciseId)) &&
    (selecting || value.operation === "clear") &&
    isNullableUuid(value.equipmentItemId) && isNullableUuid(value.attachmentItemId) &&
    isNullableUuid(value.expectedCurrentSnapshotId) &&
    isNullableUuid(value.predecessorSelectionClientKey) &&
    (value.provenance === null || value.provenance === "auto_unique" || value.provenance === "user_selected") &&
    (value.equipmentLabel === null || (typeof value.equipmentLabel === "string" && value.equipmentLabel.length <= 200)) &&
    (value.attachmentLabel === null || (typeof value.attachmentLabel === "string" && value.attachmentLabel.length <= 200)) &&
    isDate(value.createdAtISO) &&
    (value.status === "queued" || value.status === "needs_attention") &&
    Number.isInteger(value.attemptCount) && Number(value.attemptCount) >= 0 &&
    (value.nextAttemptAtISO === null || isDate(value.nextAttemptAtISO)) &&
    (value.lastAttemptAtISO === null || isDate(value.lastAttemptAtISO)) &&
    (value.lastError === null || (typeof value.lastError === "string" && value.lastError.length <= 500)) &&
    (selecting
      ? value.equipmentItemId !== null && value.provenance !== null
      : value.equipmentItemId === null && value.attachmentItemId === null && value.provenance === null);
}
function ordered<T extends { createdAtISO: string; clientKey: string }>(entries: T[]) {
  return [...entries].sort((a, b) =>
    Date.parse(a.createdAtISO) - Date.parse(b.createdAtISO) ||
    a.clientKey.localeCompare(b.clientKey));
}

export function parseEquipmentSelectionOutbox(raw: string | null): EquipmentSelectionOutboxSnapshot {
  if (!raw) return EMPTY;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    return { ...EMPTY, error: "The saved equipment setup queue could not be read. It was left unchanged." };
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return { ...EMPTY, error: "The saved equipment setup queue uses an unsupported format. It was left unchanged." };
  }
  const entries: EquipmentSelectionOutboxEntry[] = [];
  const quarantined: QuarantinedEquipmentSelection[] = [];
  const identities = new Set<string>();
  parsed.entries.forEach((rawEntry, index) => {
    if (isRecord(rawEntry) && rawEntry.quarantine === "equipment-selection-outbox-entry-v1" &&
      "raw" in rawEntry && typeof rawEntry.reason === "string") {
      quarantined.push({ quarantineKey: `quarantined:${index}`, raw: rawEntry.raw, reason: rawEntry.reason });
      return;
    }
    if (!isEntry(rawEntry) || identities.has(rawEntry.clientKey)) {
      quarantined.push({
        quarantineKey: `entries:${index}`,
        raw: rawEntry,
        reason: !isEntry(rawEntry)
          ? "This saved equipment command is incomplete or invalid."
          : "This saved equipment command repeats an earlier identity.",
      });
      return;
    }
    identities.add(rawEntry.clientKey);
    entries.push(rawEntry);
  });
  return { entries: ordered(entries), quarantined, error: null };
}

export function readEquipmentSelectionOutbox(storage: WorkoutSetOutboxStorage) {
  try { return parseEquipmentSelectionOutbox(storage.getItem(EQUIPMENT_SELECTION_OUTBOX_STORAGE_KEY)); }
  catch { return { ...EMPTY, error: "This browser would not open the saved equipment setup queue." }; }
}

export function hasPendingEquipmentSelection(
  snapshot: EquipmentSelectionOutboxSnapshot,
  identity: { ownerId: string; sessionId: string; sessionExerciseId: string },
) {
  return snapshot.entries.some((entry) =>
    entry.ownerId === identity.ownerId &&
    entry.sessionId === identity.sessionId &&
    entry.sessionExerciseId === identity.sessionExerciseId,
  );
}

export type EquipmentSelectionComparisonState =
  | "safe"
  | "pending_or_failed"
  | "unreadable";

/**
 * Previous-set evidence is server-projected from the acknowledged equipment
 * snapshot. Any retained device command can describe a newer physical setup,
 * including one with the same load-entry meaning but different geometry.
 */
export function equipmentSelectionComparisonState(
  snapshot: EquipmentSelectionOutboxSnapshot,
  identity: { ownerId: string; sessionId: string; sessionExerciseId: string },
): EquipmentSelectionComparisonState {
  if (snapshot.error != null || snapshot.quarantined.length > 0) {
    return "unreadable";
  }
  return hasPendingEquipmentSelection(snapshot, identity)
    ? "pending_or_failed"
    : "safe";
}
function write(storage: WorkoutSetOutboxStorage, snapshot: EquipmentSelectionOutboxSnapshot) {
  storage.setItem(EQUIPMENT_SELECTION_OUTBOX_STORAGE_KEY, JSON.stringify({
    version: 1,
    entries: [
      ...ordered(snapshot.entries),
      ...snapshot.quarantined.map((item) => ({
        quarantine: "equipment-selection-outbox-entry-v1",
        raw: item.raw,
        reason: item.reason,
      })),
    ],
  }));
}

export function enqueueEquipmentSelectionOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  input: NewEquipmentSelectionOutboxEntry,
  now = Date.now(),
): MutationResult {
  const current = readEquipmentSelectionOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const existing = current.entries.find((entry) => entry.clientKey === input.clientKey);
  if (existing) {
    const same = entryComparable(existing) === entryComparable(input);
    return same ? { ok: true, entry: existing } : {
      ok: false,
      reason: "That equipment command identity already belongs to different values.",
    };
  }
  if (input.provenance === "auto_unique") {
    const automatic = current.entries.find((entry) =>
      entry.ownerId === input.ownerId &&
      entry.sessionId === input.sessionId &&
      entry.sessionExerciseId === input.sessionExerciseId &&
      entry.provenance === "auto_unique",
    );
    if (automatic) return { ok: true, entry: automatic };
  }
  if (current.entries.length + current.quarantined.length >= MAX_ENTRIES) {
    return { ok: false, reason: "The equipment setup queue is full. Review an older command first." };
  }
  const entry: EquipmentSelectionOutboxEntry = {
    ...input,
    createdAtISO: nextWorkoutCommandCreatedAt(storage, now),
    status: "queued", attemptCount: 0, nextAttemptAtISO: null,
    lastAttemptAtISO: null, lastError: null,
  };
  if (!isEntry(entry)) return { ok: false, reason: "The equipment setup command is invalid." };
  try { write(storage, { ...current, entries: [...current.entries, entry] }); return { ok: true, entry }; }
  catch { return { ok: false, reason: "This browser could not retain the equipment choice safely." }; }
}

export function removeEquipmentSelectionOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  clientKey: string,
): MutationResult {
  const current = readEquipmentSelectionOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  const setOutbox = readWorkoutSetOutbox(storage);
  if (setOutbox.error || setOutbox.quarantined.length > 0) {
    return {
      ok: false,
      reason: "Resolve every unreadable saved set copy before removing an equipment choice.",
    };
  }
  if (setOutbox.entries.some(
    (set) => set.equipmentSelectionClientKey === clientKey,
  )) {
    return {
      ok: false,
      reason: "Remove the saved set that depends on this equipment choice first.",
    };
  }
  if (current.entries.some(
    (candidate) => candidate.predecessorSelectionClientKey === clientKey,
  )) {
    return {
      ok: false,
      reason: "Remove the later equipment choice that depends on this one first.",
    };
  }
  try {
    write(storage, {
      ...current,
      entries: current.entries.filter((item) => item.clientKey !== clientKey),
    });
    return { ok: true, entry };
  } catch {
    return { ok: false, reason: "This browser could not remove the equipment choice." };
  }
}

export function removeEquipmentSelectionOutboxEntryForOwner(
  storage: WorkoutSetOutboxStorage,
  ownerId: string,
  clientKey: string,
): MutationResult {
  const current = readEquipmentSelectionOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  if (entry.ownerId !== ownerId) {
    return {
      ok: false,
      reason: "The saved equipment choice now belongs to a different account.",
    };
  }
  return removeEquipmentSelectionOutboxEntry(storage, clientKey);
}

function sameRawValue(left: unknown, right: unknown) {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
}

export function discardQuarantinedEquipmentSelectionOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  quarantineKey: string,
  expectedRaw: unknown,
): MutationResult {
  const current = readEquipmentSelectionOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const selected = current.quarantined.find(
    (item) => item.quarantineKey === quarantineKey,
  );
  if (!selected || !sameRawValue(selected.raw, expectedRaw)) {
    return {
      ok: false,
      reason: "The unreadable equipment copy changed before it could be discarded.",
    };
  }
  const possibleClientKey = isRecord(selected.raw) &&
    typeof selected.raw.clientKey === "string" && UUID.test(selected.raw.clientKey)
    ? selected.raw.clientKey
    : null;
  const setOutbox = readWorkoutSetOutbox(storage);
  if (setOutbox.error || setOutbox.quarantined.length > 0) {
    return {
      ok: false,
      reason: "Resolve every unreadable saved set copy before discarding an equipment copy.",
    };
  }
  if (possibleClientKey && setOutbox.entries.some(
    (set) => set.equipmentSelectionClientKey === possibleClientKey,
  )) {
    return {
      ok: false,
      reason: "Remove the saved set that may depend on this unreadable equipment copy first.",
    };
  }
  if (possibleClientKey && current.entries.some(
    (entry) => entry.predecessorSelectionClientKey === possibleClientKey,
  )) {
    return {
      ok: false,
      reason: "Remove the later equipment choice that may depend on this unreadable copy first.",
    };
  }
  try {
    write(storage, {
      ...current,
      quarantined: current.quarantined.filter(
        (item) => item.quarantineKey !== quarantineKey,
      ),
    });
    return { ok: true, entry: null };
  } catch {
    return { ok: false, reason: "This browser could not discard the unreadable equipment copy." };
  }
}

function entryComparable(entry: NewEquipmentSelectionOutboxEntry | EquipmentSelectionOutboxEntry) {
  return JSON.stringify({
    clientKey: entry.clientKey, ownerId: entry.ownerId, sessionId: entry.sessionId,
    sessionExerciseId: entry.sessionExerciseId, operation: entry.operation,
    equipmentItemId: entry.equipmentItemId, attachmentItemId: entry.attachmentItemId,
    expectedCurrentSnapshotId: entry.expectedCurrentSnapshotId,
    predecessorSelectionClientKey: entry.predecessorSelectionClientKey,
    provenance: entry.provenance, equipmentLabel: entry.equipmentLabel,
    attachmentLabel: entry.attachmentLabel,
  });
}

function replaceInStorage(
  storage: WorkoutSetOutboxStorage,
  clientKey: string,
  update: (entry: EquipmentSelectionOutboxEntry) => EquipmentSelectionOutboxEntry,
): MutationResult {
  const current = readEquipmentSelectionOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const index = current.entries.findIndex((entry) => entry.clientKey === clientKey);
  if (index < 0) return { ok: true, entry: null };
  const entry = update(current.entries[index]);
  if (!isEntry(entry)) return { ok: false, reason: "The equipment queue update was invalid." };
  const entries = [...current.entries]; entries[index] = entry;
  try { write(storage, { ...current, entries }); return { ok: true, entry }; }
  catch { return { ok: false, reason: "This browser could not update the equipment queue." }; }
}

function replace(clientKey: string, update: (entry: EquipmentSelectionOutboxEntry) => EquipmentSelectionOutboxEntry): MutationResult {
  const storage = browserStorage();
  if (!storage) return { ok: false, reason: "This browser could not retain the equipment choice safely." };
  const result = replaceInStorage(storage, clientKey, update);
  if (result.ok) notify();
  return result;
}

export function markEquipmentSelectionTransientFailure(
  storage: WorkoutSetOutboxStorage,
  clientKey: string,
  reason: string,
  now = new Date(),
) {
  return replaceInStorage(storage, clientKey, (entry) => {
    const attemptCount = entry.attemptCount + 1;
    const paused = attemptCount >= MAX_AUTO_ATTEMPTS;
    const delays = [1000, 3000, 10000, 30000, 120000, 300000];
    return { ...entry, attemptCount, status: paused ? "needs_attention" : "queued",
      lastAttemptAtISO: now.toISOString(),
      nextAttemptAtISO: paused ? null : new Date(now.getTime() + delays[Math.min(attemptCount - 1, 5)]).toISOString(),
      lastError: (paused ? "Automatic retry paused after repeated connection failures." : reason).slice(0, 500) };
  });
}

export function markEquipmentSelectionTransientFailureUnlocked(clientKey: string, reason: string, now = new Date()) {
  const storage = browserStorage();
  if (!storage) return { ok: false as const, reason: "This browser could not retain the equipment choice safely." };
  const result = markEquipmentSelectionTransientFailure(storage, clientKey, reason, now);
  if (result.ok) notify();
  return result;
}
export function markEquipmentSelectionNeedsAttentionUnlocked(clientKey: string, reason: string) {
  return replace(clientKey, (entry) => ({ ...entry, status: "needs_attention", attemptCount: entry.attemptCount + 1,
    nextAttemptAtISO: null, lastAttemptAtISO: new Date().toISOString(), lastError: reason.slice(0, 500) }));
}
export function retryEquipmentSelection(clientKey: string) {
  return withOutboxLock(() => replace(clientKey, (entry) => ({ ...entry, status: "queued", attemptCount: 0,
    nextAttemptAtISO: null, lastError: null })));
}
export function releaseQueuedEquipmentSelectionBackoff(ownerId: string) {
  const storage = browserStorage();
  if (!storage) return Promise.resolve({ ok: false as const, reason: "This browser could not update the equipment queue." });
  return withOutboxLock(() => {
    const current = readEquipmentSelectionOutbox(storage);
    if (current.error) return { ok: false as const, reason: current.error };
    try {
      write(storage, {
        ...current,
        entries: current.entries.map((entry) =>
          entry.ownerId === ownerId && entry.status === "queued"
            ? { ...entry, nextAttemptAtISO: null }
            : entry),
      });
      notify();
      return { ok: true as const, entry: null };
    } catch {
      return { ok: false as const, reason: "This browser could not release the equipment retry delay." };
    }
  });
}

/** Caller holds the shared lock. Sets are patched before this is called. */
export function acknowledgeEquipmentSelectionUnlocked(
  clientKey: string,
  snapshotId: string | null,
  occurrenceStates: ReadonlyArray<EquipmentSelectionOccurrenceAcknowledgement> = [],
): MutationResult {
  const storage = browserStorage();
  if (!storage) return { ok: false, reason: "This browser could not update the equipment queue." };
  const result = acknowledgeEquipmentSelectionOutboxEntry(
    storage,
    clientKey,
    snapshotId,
    occurrenceStates,
  );
  notify();
  return result;
}
export function acknowledgeEquipmentSelectionOutboxEntry(
  storage: WorkoutSetOutboxStorage,
  clientKey: string,
  snapshotId: string | null,
  occurrenceStates: ReadonlyArray<EquipmentSelectionOccurrenceAcknowledgement> = [],
): MutationResult {
  const current = readEquipmentSelectionOutbox(storage);
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  const receipt = recordEquipmentSelectionAcknowledgement(storage, {
    clientKey: entry.clientKey,
    ownerId: entry.ownerId,
    sessionId: entry.sessionId,
    sessionExerciseId: entry.sessionExerciseId,
    snapshotId,
    occurrenceStates: occurrenceStates.map((state) => ({
      id: state.id,
      ...(state.previousRevision == null
        ? {}
        : { previousRevision: state.previousRevision }),
      revision: state.revision,
      ...(state.outcome == null ? {} : { outcome: state.outcome }),
    })),
    acknowledgedAtISO: new Date().toISOString(),
  });
  if (!receipt.ok) return receipt;
  const entries = current.entries
    .filter((item) => item.clientKey !== clientKey)
    .map((item) => item.predecessorSelectionClientKey === clientKey
      ? { ...item, predecessorSelectionClientKey: null, expectedCurrentSnapshotId: snapshotId }
      : item);
  try { write(storage, { ...current, entries }); return { ok: true, entry }; }
  catch { return { ok: false, reason: "This browser could not acknowledge the equipment choice." }; }
}

export function nextWorkoutCommand(
  ownerId: string,
  sets: WorkoutSetOutboxEntry[],
  selections: EquipmentSelectionOutboxEntry[],
  now = new Date(),
): { kind: "set"; entry: WorkoutSetOutboxEntry } | { kind: "selection"; entry: EquipmentSelectionOutboxEntry } | null {
  type Command =
    | { kind: "set"; entry: WorkoutSetOutboxEntry; createdAtISO: string; clientKey: string }
    | { kind: "selection"; entry: EquipmentSelectionOutboxEntry; createdAtISO: string; clientKey: string };
  const commands: Command[] = ordered<Command>([
    ...sets.filter((entry) => entry.ownerId === ownerId).map((entry) => ({ kind: "set" as const, entry, createdAtISO: entry.createdAtISO, clientKey: entry.clientKey })),
    ...selections.filter((entry) => entry.ownerId === ownerId).map((entry) => ({ kind: "selection" as const, entry, createdAtISO: entry.createdAtISO, clientKey: entry.clientKey })),
  ]);
  const blocked = new Map<string, WorkoutSetOutboxEntry | EquipmentSelectionOutboxEntry>();
  const recoverySelectionKeysByExercise = new Map<string, Set<string>>();
  for (const blockedSet of sets) {
    const blockerOccurrenceId = blockedSet.orderBlocker?.occurrenceId;
    if (!blockerOccurrenceId) continue;
    const recoverySet = sets.find(
      (candidate) =>
        candidate.ownerId === ownerId &&
        candidate.sessionExerciseId === blockedSet.sessionExerciseId &&
        candidate.occurrenceId === blockerOccurrenceId,
    );
    if (recoverySet) {
      const dependencyKeys = new Set<string>();
      let selectionKey = recoverySet.equipmentSelectionClientKey;
      while (selectionKey && !dependencyKeys.has(selectionKey)) {
        dependencyKeys.add(selectionKey);
        selectionKey = selections.find(
          (candidate) =>
            candidate.ownerId === ownerId &&
            candidate.sessionExerciseId === blockedSet.sessionExerciseId &&
            candidate.clientKey === selectionKey,
        )?.predecessorSelectionClientKey ?? null;
      }
      recoverySelectionKeysByExercise.set(
        blockedSet.sessionExerciseId,
        dependencyKeys,
      );
    }
  }
  for (const command of commands) {
    const blockingEntry = blocked.get(command.entry.sessionExerciseId);
    const resolvesExactBlocker =
      blockingEntry != null &&
      "orderBlocker" in blockingEntry &&
      blockingEntry.orderBlocker != null &&
      (
        (command.kind === "set" &&
          command.entry.occurrenceId ===
            blockingEntry.orderBlocker.occurrenceId) ||
        (command.kind === "selection" &&
          recoverySelectionKeysByExercise
            .get(command.entry.sessionExerciseId)
            ?.has(command.entry.clientKey) === true)
      );
    if (blockingEntry && !resolvesExactBlocker) continue;
    const dependencyPending = command.kind === "set"
      ? command.entry.equipmentSelectionClientKey != null
      : command.entry.predecessorSelectionClientKey != null;
    const entry = command.entry;
    if (entry.status === "queued" && !dependencyPending &&
      (!entry.nextAttemptAtISO || Date.parse(entry.nextAttemptAtISO) <= now.getTime())) {
      return command.kind === "set"
        ? { kind: "set", entry: command.entry }
        : { kind: "selection", entry: command.entry };
    }
    if (!resolvesExactBlocker) {
      blocked.set(entry.sessionExerciseId, entry);
    }
  }
  return null;
}

function browserStorage(): WorkoutSetOutboxStorage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}
function notify() {
  cachedRaw = undefined;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EQUIPMENT_SELECTION_OUTBOX_CHANGE_EVENT));
}
export function enqueueEquipmentSelection(input: NewEquipmentSelectionOutboxEntry) {
  const storage = browserStorage();
  if (!storage) return Promise.resolve({ ok: false as const, reason: "This browser could not retain the equipment choice safely." });
  return withOutboxLock(() => {
    const result = enqueueEquipmentSelectionOutboxEntry(storage, input);
    notify();
    return result;
  });
}
export function removeEquipmentSelection(clientKey: string) {
  const storage = browserStorage();
  if (!storage) return Promise.resolve({ ok: false as const, reason: "This browser could not update the equipment queue." });
  return withOutboxLock(() => {
    const result = removeEquipmentSelectionOutboxEntry(storage, clientKey);
    if (result.ok) notify();
    return result;
  });
}
export function removeEquipmentSelectionForOwner(ownerId: string, clientKey: string) {
  const storage = browserStorage();
  if (!storage) return Promise.resolve({ ok: false as const, reason: "This browser could not update the equipment queue." });
  return withOutboxLock(() => {
    const result = removeEquipmentSelectionOutboxEntryForOwner(
      storage,
      ownerId,
      clientKey,
    );
    if (result.ok) notify();
    return result;
  });
}
export function discardQuarantinedEquipmentSelection(
  quarantineKey: string,
  expectedRaw: unknown,
) {
  const storage = browserStorage();
  if (!storage) return Promise.resolve({ ok: false as const, reason: "This browser could not update the equipment queue." });
  return withOutboxLock(() => {
    const result = discardQuarantinedEquipmentSelectionOutboxEntry(
      storage,
      quarantineKey,
      expectedRaw,
    );
    if (result.ok) notify();
    return result;
  });
}
export function getEquipmentSelectionOutboxSnapshot() {
  const storage = browserStorage();
  if (!storage) return EMPTY;
  let raw: string | null;
  try { raw = storage.getItem(EQUIPMENT_SELECTION_OUTBOX_STORAGE_KEY); }
  catch { return { ...EMPTY, error: "This browser would not open the saved equipment setup queue." }; }
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw; cachedSnapshot = parseEquipmentSelectionOutbox(raw); return cachedSnapshot;
}
export function getEquipmentSelectionOutboxServerSnapshot() { return EMPTY; }
export function subscribeToEquipmentSelectionOutbox(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: StorageEvent) => { if (event.key === EQUIPMENT_SELECTION_OUTBOX_STORAGE_KEY) { cachedRaw = undefined; listener(); } };
  const local = () => { cachedRaw = undefined; listener(); };
  window.addEventListener("storage", handler); window.addEventListener(EQUIPMENT_SELECTION_OUTBOX_CHANGE_EVENT, local);
  return () => { window.removeEventListener("storage", handler); window.removeEventListener(EQUIPMENT_SELECTION_OUTBOX_CHANGE_EVENT, local); };
}
function statusChannel() {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return null;
  channel ??= new BroadcastChannel(STATUS_CHANNEL); return channel;
}
export function publishEquipmentSelectionOutboxEvent(detail: EquipmentSelectionOutboxEvent) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EQUIPMENT_SELECTION_OUTBOX_STATUS_EVENT, { detail }));
  statusChannel()?.postMessage(detail);
}
export function subscribeToEquipmentSelectionOutboxStatus(
  listener: (detail: EquipmentSelectionOutboxEvent) => void,
) {
  if (typeof window === "undefined") return () => undefined;
  const onWindow = (event: Event) =>
    listener((event as CustomEvent<EquipmentSelectionOutboxEvent>).detail);
  const activeChannel = statusChannel();
  const onMessage = (event: MessageEvent<EquipmentSelectionOutboxEvent>) =>
    listener(event.data);
  window.addEventListener(EQUIPMENT_SELECTION_OUTBOX_STATUS_EVENT, onWindow);
  activeChannel?.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener(EQUIPMENT_SELECTION_OUTBOX_STATUS_EVENT, onWindow);
    activeChannel?.removeEventListener("message", onMessage);
  };
}
