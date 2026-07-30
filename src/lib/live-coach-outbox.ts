export const LIVE_COACH_OUTBOX_STORAGE_KEY =
  "workout-tracker:live-coach-outbox:v1";
export const LIVE_COACH_OUTBOX_LOCK_NAME =
  "workout-tracker:live-coach-outbox";
export const LIVE_COACH_OUTBOX_CHANGE_EVENT = "live-coach-outbox-change";
export const LIVE_COACH_OUTBOX_MAX_ENTRIES = 20;
export const LIVE_COACH_OUTBOX_MAX_AUTO_ATTEMPTS = 8;

export type LiveCoachOutboxStatus = "queued" | "needs_attention";

export type LiveCoachOutboxEntry = {
  clientKey: string;
  ownerId: string;
  sessionId: string;
  sessionExerciseId: string | null;
  exerciseName: string | null;
  completedSetId: string | null;
  messageKind: "question" | "observation";
  inputMode: "text" | "dictation";
  content: string;
  activeRestTimerSeconds: number | null;
  createdAtISO: string;
  status: LiveCoachOutboxStatus;
  attemptCount: number;
  nextAttemptAtISO: string | null;
  lastAttemptAtISO: string | null;
  lastError: string | null;
};

export type NewLiveCoachOutboxEntry = Omit<
  LiveCoachOutboxEntry,
  | "status"
  | "attemptCount"
  | "nextAttemptAtISO"
  | "lastAttemptAtISO"
  | "lastError"
>;

export type LiveCoachOutboxSnapshot = {
  entries: LiveCoachOutboxEntry[];
  quarantined: LiveCoachOutboxQuarantinedEntry[];
  error: string | null;
};

export type LiveCoachOutboxQuarantinedEntry = {
  quarantineKey: string;
  raw: unknown;
  reason: string;
};

type StoredQuarantinedEntry = {
  quarantine: "live-coach-outbox-entry-v1";
  raw: unknown;
  reason: string;
};
const LIVE_COACH_QUARANTINE_REASONS = [
  "This saved Coach message is incomplete or invalid.",
  "This saved Coach message repeats an earlier identity.",
] as const;
type LiveCoachQuarantineReason =
  (typeof LIVE_COACH_QUARANTINE_REASONS)[number];

type OutboxEnvelope = {
  version: 1;
  entries: unknown[];
};

export type LiveCoachOutboxStorage = Pick<Storage, "getItem" | "setItem">;

type MutationResult =
  | { ok: true; entry: LiveCoachOutboxEntry | null }
  | { ok: false; reason: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_SNAPSHOT: LiveCoachOutboxSnapshot = {
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

function isStoredQuarantinedEntry(
  value: unknown
): value is StoredQuarantinedEntry {
  return (
    isRecord(value) &&
    value.quarantine === "live-coach-outbox-entry-v1" &&
    Object.hasOwn(value, "raw") &&
    LIVE_COACH_QUARANTINE_REASONS.includes(
      value.reason as LiveCoachQuarantineReason
    )
  );
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID_PATTERN.test(value));
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || isDate(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isLiveCoachOutboxEntry(value: unknown): value is LiveCoachOutboxEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.clientKey === "string" &&
    UUID_PATTERN.test(value.clientKey) &&
    typeof value.ownerId === "string" &&
    UUID_PATTERN.test(value.ownerId) &&
    typeof value.sessionId === "string" &&
    UUID_PATTERN.test(value.sessionId) &&
    isNullableUuid(value.sessionExerciseId) &&
    (value.exerciseName === null ||
      (typeof value.exerciseName === "string" &&
        value.exerciseName.length <= 200)) &&
    isNullableUuid(value.completedSetId) &&
    (value.messageKind === "question" || value.messageKind === "observation") &&
    (value.inputMode === "text" || value.inputMode === "dictation") &&
    typeof value.content === "string" &&
    value.content.trim().length >= 2 &&
    value.content.length <= 800 &&
    (value.activeRestTimerSeconds === null ||
      (typeof value.activeRestTimerSeconds === "number" &&
        Number.isInteger(value.activeRestTimerSeconds) &&
        value.activeRestTimerSeconds >= 0 &&
        value.activeRestTimerSeconds <= 3600)) &&
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

export function parseLiveCoachOutbox(raw: string | null): LiveCoachOutboxSnapshot {
  if (raw == null || raw === "") return EMPTY_SNAPSHOT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      entries: [],
      quarantined: [],
      error:
        "The saved Coach outbox on this device could not be read. It was left unchanged.",
    };
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    return {
      entries: [],
      quarantined: [],
      error:
        "The saved Coach outbox on this device uses an unsupported format. It was left unchanged.",
    };
  }
  const entries: LiveCoachOutboxEntry[] = [];
  const quarantined: LiveCoachOutboxQuarantinedEntry[] = [];
  const clientKeys = new Set<string>();
  value.entries.forEach((raw, storageIndex) => {
    if (isStoredQuarantinedEntry(raw)) {
      quarantined.push({
        quarantineKey: `quarantined:${storageIndex}`,
        raw: raw.raw,
        reason: raw.reason,
      });
      return;
    }
    if (!isLiveCoachOutboxEntry(raw)) {
      quarantined.push({
        quarantineKey: `entries:${storageIndex}`,
        raw,
        reason: "This saved Coach message is incomplete or invalid.",
      });
      return;
    }
    if (clientKeys.has(raw.clientKey)) {
      quarantined.push({
        quarantineKey: `entries:${storageIndex}`,
        raw,
        reason: "This saved Coach message repeats an earlier identity.",
      });
      return;
    }
    clientKeys.add(raw.clientKey);
    entries.push(raw);
  });
  return {
    entries: entries.sort(
      (a, b) =>
        Date.parse(a.createdAtISO) - Date.parse(b.createdAtISO) ||
        a.clientKey.localeCompare(b.clientKey)
    ),
    quarantined,
    error: null,
  };
}

export function readLiveCoachOutbox(
  storage: LiveCoachOutboxStorage
): LiveCoachOutboxSnapshot {
  try {
    return parseLiveCoachOutbox(storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY));
  } catch {
    return {
      entries: [],
      quarantined: [],
      error:
        "This browser would not open the Coach outbox. The message was not sent.",
    };
  }
}

function writeLiveCoachOutbox(
  storage: LiveCoachOutboxStorage,
  entries: LiveCoachOutboxEntry[],
  quarantined: LiveCoachOutboxQuarantinedEntry[]
) {
  const envelope: OutboxEnvelope = {
    version: 1,
    entries: [
      ...entries,
      ...quarantined.map(
        ({ raw, reason }): StoredQuarantinedEntry => ({
          quarantine: "live-coach-outbox-entry-v1",
          raw,
          reason,
        })
      ),
    ],
  };
  storage.setItem(LIVE_COACH_OUTBOX_STORAGE_KEY, JSON.stringify(envelope));
}

export function enqueueLiveCoachOutboxEntry(
  storage: LiveCoachOutboxStorage,
  input: NewLiveCoachOutboxEntry
): MutationResult {
  const current = readLiveCoachOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const existing = current.entries.find(
    (entry) => entry.clientKey === input.clientKey
  );
  if (existing) {
    const same =
      existing.ownerId === input.ownerId &&
      existing.sessionId === input.sessionId &&
      existing.sessionExerciseId === input.sessionExerciseId &&
      existing.completedSetId === input.completedSetId &&
      existing.messageKind === input.messageKind &&
      existing.inputMode === input.inputMode &&
      existing.content === input.content;
    return same
      ? { ok: true, entry: existing }
      : {
          ok: false,
          reason:
            "That saved Coach identity already belongs to a different message.",
        };
  }
  if (
    current.entries.length + current.quarantined.length >=
    LIVE_COACH_OUTBOX_MAX_ENTRIES
  ) {
    return {
      ok: false,
      reason:
        "The Coach outbox is full. Recover or remove an older queued message before adding another.",
    };
  }
  const entry: LiveCoachOutboxEntry = {
    ...input,
    content: input.content.trim(),
    status: "queued",
    attemptCount: 0,
    nextAttemptAtISO: null,
    lastAttemptAtISO: null,
    lastError: null,
  };
  if (!isLiveCoachOutboxEntry(entry)) {
    return {
      ok: false,
      reason: "The Coach message could not be prepared for safe device storage.",
    };
  }
  try {
    writeLiveCoachOutbox(storage, [...current.entries, entry], current.quarantined);
    return { ok: true, entry };
  } catch {
    return {
      ok: false,
      reason:
        "This browser could not retain the Coach message safely. The message was not sent.",
    };
  }
}

function replaceEntry(
  storage: LiveCoachOutboxStorage,
  clientKey: string,
  replacement: (entry: LiveCoachOutboxEntry) => LiveCoachOutboxEntry
): MutationResult {
  const current = readLiveCoachOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const index = current.entries.findIndex((entry) => entry.clientKey === clientKey);
  if (index < 0) return { ok: true, entry: null };
  const entry = replacement(current.entries[index]);
  if (!isLiveCoachOutboxEntry(entry)) {
    return { ok: false, reason: "The queued Coach message update was invalid." };
  }
  const entries = [...current.entries];
  entries[index] = entry;
  try {
    writeLiveCoachOutbox(storage, entries, current.quarantined);
    return { ok: true, entry };
  } catch {
    return {
      ok: false,
      reason: "This browser could not update the saved Coach message.",
    };
  }
}

export function markLiveCoachOutboxTransientFailure(
  storage: LiveCoachOutboxStorage,
  clientKey: string,
  reason: string,
  now = new Date()
): MutationResult {
  return replaceEntry(storage, clientKey, (entry) => {
    const attemptCount = entry.attemptCount + 1;
    const paused = attemptCount >= LIVE_COACH_OUTBOX_MAX_AUTO_ATTEMPTS;
    return {
      ...entry,
      status: paused ? "needs_attention" : "queued",
      attemptCount,
      lastAttemptAtISO: now.toISOString(),
      nextAttemptAtISO: paused
        ? null
        : new Date(
            now.getTime() + nextLiveCoachRetryDelayMs(attemptCount)
          ).toISOString(),
      lastError: paused
        ? "Automatic retry paused after repeated connection failures. Try again when ready."
        : reason.slice(0, 500),
    };
  });
}

export function markLiveCoachOutboxNeedsAttention(
  storage: LiveCoachOutboxStorage,
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

export function retryLiveCoachOutboxEntry(
  storage: LiveCoachOutboxStorage,
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

export function removeLiveCoachOutboxEntry(
  storage: LiveCoachOutboxStorage,
  clientKey: string
): MutationResult {
  const current = readLiveCoachOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  try {
    writeLiveCoachOutbox(
      storage,
      current.entries.filter((item) => item.clientKey !== clientKey),
      current.quarantined
    );
    return { ok: true, entry };
  } catch {
    return {
      ok: false,
      reason: "This browser could not remove the saved Coach message.",
    };
  }
}

export function removeLiveCoachOutboxEntryForOwner(
  storage: LiveCoachOutboxStorage,
  ownerId: string,
  clientKey: string
): MutationResult {
  const current = readLiveCoachOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  if (entry.ownerId !== ownerId) {
    return {
      ok: false,
      reason: "The saved Coach message now belongs to a different account.",
    };
  }
  return removeLiveCoachOutboxEntry(storage, clientKey);
}

export function discardLiveCoachOutboxQuarantinedEntry(
  storage: LiveCoachOutboxStorage,
  quarantineKey: string,
  expectedRaw: unknown
): MutationResult {
  const current = readLiveCoachOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const selected = current.quarantined.find(
    (entry) => entry.quarantineKey === quarantineKey
  );
  if (!selected || !hasSameRawValue(selected.raw, expectedRaw)) {
    return {
      ok: false,
      reason:
        "The unreadable Coach message changed before it could be removed. Review the outbox again.",
    };
  }
  try {
    writeLiveCoachOutbox(
      storage,
      current.entries,
      current.quarantined.filter(
        (entry) => entry.quarantineKey !== quarantineKey
      )
    );
    return { ok: true, entry: null };
  } catch {
    return {
      ok: false,
      reason: "This browser could not remove the unreadable Coach message.",
    };
  }
}

export function nextLiveCoachRetryDelayMs(attemptCount: number) {
  const delays = [1_000, 3_000, 10_000, 30_000, 120_000, 300_000];
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
}

function browserStorage(): LiveCoachOutboxStorage | null {
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
    window.dispatchEvent(new Event(LIVE_COACH_OUTBOX_CHANGE_EVENT));
  }
}

function applyBrowserMutation(
  storage: LiveCoachOutboxStorage,
  mutation: (storage: LiveCoachOutboxStorage) => MutationResult
) {
  const result = mutation(storage);
  if (result.ok) notifyOutboxChange();
  return result;
}

export async function withLiveCoachOutboxLock<T>(
  task: () => T | Promise<T>
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      LIVE_COACH_OUTBOX_LOCK_NAME,
      { mode: "exclusive" },
      task
    );
  }
  return task();
}

async function runBrowserMutation(
  mutation: (storage: LiveCoachOutboxStorage) => MutationResult
) {
  const storage = browserStorage();
  if (!storage) {
    return {
      ok: false as const,
      reason:
        "This browser could not retain the Coach message safely. The message was not sent.",
    };
  }
  return withLiveCoachOutboxLock(() => applyBrowserMutation(storage, mutation));
}

function runUnlockedBrowserMutation(
  mutation: (storage: LiveCoachOutboxStorage) => MutationResult
) {
  const storage = browserStorage();
  if (!storage) {
    return {
      ok: false as const,
      reason:
        "This browser could not retain the Coach message safely. The message was not sent.",
    };
  }
  return applyBrowserMutation(storage, mutation);
}

export function enqueueLiveCoachMessage(input: NewLiveCoachOutboxEntry) {
  return runBrowserMutation((storage) =>
    enqueueLiveCoachOutboxEntry(storage, input)
  );
}

export function recordLiveCoachOutboxTransientFailure(
  clientKey: string,
  reason: string
) {
  return runBrowserMutation((storage) =>
    markLiveCoachOutboxTransientFailure(storage, clientKey, reason)
  );
}

export function recordLiveCoachOutboxTransientFailureUnlocked(
  clientKey: string,
  reason: string
) {
  return runUnlockedBrowserMutation((storage) =>
    markLiveCoachOutboxTransientFailure(storage, clientKey, reason)
  );
}

export function recordLiveCoachOutboxNeedsAttention(
  clientKey: string,
  reason: string
) {
  return runBrowserMutation((storage) =>
    markLiveCoachOutboxNeedsAttention(storage, clientKey, reason)
  );
}

export function recordLiveCoachOutboxNeedsAttentionUnlocked(
  clientKey: string,
  reason: string
) {
  return runUnlockedBrowserMutation((storage) =>
    markLiveCoachOutboxNeedsAttention(storage, clientKey, reason)
  );
}

export function retryLiveCoachMessage(clientKey: string) {
  return runBrowserMutation((storage) =>
    retryLiveCoachOutboxEntry(storage, clientKey)
  );
}

export function removeLiveCoachMessage(clientKey: string) {
  return runBrowserMutation((storage) =>
    removeLiveCoachOutboxEntry(storage, clientKey)
  );
}

export function removeLiveCoachMessageForOwner(ownerId: string, clientKey: string) {
  return runBrowserMutation((storage) =>
    removeLiveCoachOutboxEntryForOwner(storage, ownerId, clientKey)
  );
}

export function removeLiveCoachMessageUnlocked(clientKey: string) {
  return runUnlockedBrowserMutation((storage) =>
    removeLiveCoachOutboxEntry(storage, clientKey)
  );
}

export function discardLiveCoachQuarantinedMessage(
  quarantineKey: string,
  expectedRaw: unknown
) {
  return runBrowserMutation((storage) =>
    discardLiveCoachOutboxQuarantinedEntry(
      storage,
      quarantineKey,
      expectedRaw
    )
  );
}

export function getLiveCoachOutboxSnapshot(): LiveCoachOutboxSnapshot {
  const storage = browserStorage();
  if (!storage) return EMPTY_SNAPSHOT;
  let raw: string | null;
  try {
    raw = storage.getItem(LIVE_COACH_OUTBOX_STORAGE_KEY);
  } catch {
    return {
      entries: [],
      quarantined: [],
      error: "This browser would not open the Coach outbox.",
    };
  }
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;
  cachedSnapshot = parseLiveCoachOutbox(raw);
  return cachedSnapshot;
}

export function getLiveCoachOutboxServerSnapshot() {
  return EMPTY_SNAPSHOT;
}

export function subscribeToLiveCoachOutbox(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === LIVE_COACH_OUTBOX_STORAGE_KEY) {
      cachedRaw = undefined;
      onStoreChange();
    }
  };
  const onLocalChange = () => {
    cachedRaw = undefined;
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(LIVE_COACH_OUTBOX_CHANGE_EVENT, onLocalChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LIVE_COACH_OUTBOX_CHANGE_EVENT, onLocalChange);
  };
}
