export const OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY =
  "workout-tracker:occurrence-mutation-outbox:v1";
export const OCCURRENCE_MUTATION_OUTBOX_CHANGE_EVENT =
  "occurrence-mutation-outbox-change";
export const OCCURRENCE_MUTATION_OUTBOX_STATUS_EVENT =
  "occurrence-mutation-outbox-status";
export const OCCURRENCE_MUTATION_OUTBOX_LOCK_NAME =
  "workout-tracker:occurrence-mutation-outbox";
const STATUS_CHANNEL_NAME = "occurrence-mutation-outbox-status-v1";
export const OCCURRENCE_MUTATION_OUTBOX_MAX_AUTO_ATTEMPTS = 6;
export const OCCURRENCE_MUTATION_OUTBOX_MAX_ENTRIES = 100;
export const OCCURRENCE_MUTATION_OUTBOX_MAX_DISPLAY_LABEL_LENGTH = 200;

export type OccurrenceMutationOperation =
  | "complete"
  | "skip"
  | "restore"
  | "note";

export type OccurrenceMutationOutboxEntry = {
  clientKey: string;
  ownerId: string;
  sessionId: string;
  occurrenceId: string;
  label: string;
  expectedRevision: number;
  operation: OccurrenceMutationOperation;
  reason: string | null;
  note: string | null;
  createdAtISO: string;
  status: "queued" | "needs_attention";
  attemptCount: number;
  nextAttemptAtISO: string | null;
  lastAttemptAtISO: string | null;
  lastError: string | null;
};

export type NewOccurrenceMutationOutboxEntry = Omit<
  OccurrenceMutationOutboxEntry,
  | "status"
  | "attemptCount"
  | "nextAttemptAtISO"
  | "lastAttemptAtISO"
  | "lastError"
>;

export type OccurrenceMutationOutboxSnapshot = {
  entries: OccurrenceMutationOutboxEntry[];
  error: string | null;
};

export type OccurrenceMutationServerState = {
  id: string;
  state: string;
  reason: string | null;
  note: string | null;
  revision: number;
  resolvedAt: string | null;
};

export type OccurrenceMutationOutboxClientEvent =
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
      occurrence: OccurrenceMutationServerState;
    }
  | { type: "failed"; clientKey: string; sessionId: string }
  | { type: "discarded"; clientKey: string; sessionId: string };

export type OccurrenceMutationOutboxStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

type MutationResult =
  | { ok: true; entry: OccurrenceMutationOutboxEntry | null }
  | { ok: false; reason: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_SNAPSHOT: OccurrenceMutationOutboxSnapshot = {
  entries: [],
  error: null,
};
let cachedRaw: string | null | undefined;
let cachedSnapshot = EMPTY_SNAPSHOT;
let statusChannel: BroadcastChannel | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || isDate(value);
}

function isEntry(value: unknown): value is OccurrenceMutationOutboxEntry {
  if (!isRecord(value)) return false;
  const operationPayloadValid =
    (value.operation === "skip" &&
      typeof value.reason === "string" &&
      value.reason.trim().length > 0) ||
    (value.operation === "note" && value.reason === null) ||
    ((value.operation === "complete" || value.operation === "restore") &&
      value.reason === null &&
      value.note === null);
  return (
    typeof value.clientKey === "string" &&
    UUID_PATTERN.test(value.clientKey) &&
    typeof value.ownerId === "string" &&
    UUID_PATTERN.test(value.ownerId) &&
    typeof value.sessionId === "string" &&
    UUID_PATTERN.test(value.sessionId) &&
    typeof value.occurrenceId === "string" &&
    UUID_PATTERN.test(value.occurrenceId) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= OCCURRENCE_MUTATION_OUTBOX_MAX_DISPLAY_LABEL_LENGTH &&
    typeof value.expectedRevision === "number" &&
    Number.isInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    ["complete", "skip", "restore", "note"].includes(
      String(value.operation),
    ) &&
    operationPayloadValid &&
    (value.reason === null ||
      (typeof value.reason === "string" && value.reason.length <= 160)) &&
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

export function normalizeOccurrenceMutationDisplayLabel(label: string) {
  const normalized = label.trim() || "Workout item";
  if (
    normalized.length <= OCCURRENCE_MUTATION_OUTBOX_MAX_DISPLAY_LABEL_LENGTH
  ) {
    return normalized;
  }
  return `${normalized.slice(
    0,
    OCCURRENCE_MUTATION_OUTBOX_MAX_DISPLAY_LABEL_LENGTH - 1,
  )}…`;
}

function ordered(entries: OccurrenceMutationOutboxEntry[]) {
  return [...entries].sort(
    (left, right) => {
      if (
        left.ownerId === right.ownerId &&
        left.occurrenceId === right.occurrenceId &&
        left.expectedRevision !== right.expectedRevision
      ) {
        return left.expectedRevision - right.expectedRevision;
      }
      return (
        Date.parse(left.createdAtISO) - Date.parse(right.createdAtISO) ||
        left.clientKey.localeCompare(right.clientKey)
      );
    },
  );
}

export function occurrenceMutationFinishIsBlocked(
  entries: OccurrenceMutationOutboxEntry[],
  snapshot: Pick<OccurrenceMutationOutboxSnapshot, "error">,
) {
  return entries.length > 0 || snapshot.error != null;
}

export function parseOccurrenceMutationOutbox(
  raw: string | null,
): OccurrenceMutationOutboxSnapshot {
  if (raw == null || raw === "") return EMPTY_SNAPSHOT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      entries: [],
      error:
        "The saved workout-item queue on this device could not be read. It was left unchanged.",
    };
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    return {
      entries: [],
      error:
        "The saved workout-item queue uses an unsupported format. It was left unchanged.",
    };
  }
  const entries: OccurrenceMutationOutboxEntry[] = [];
  const identities = new Set<string>();
  for (const candidate of value.entries) {
    if (!isEntry(candidate) || identities.has(candidate.clientKey)) {
      return {
        entries: [],
        error:
          "The saved workout-item queue contains an invalid device copy. It was left unchanged.",
      };
    }
    identities.add(candidate.clientKey);
    entries.push(candidate);
  }
  return { entries: ordered(entries), error: null };
}

export function readOccurrenceMutationOutbox(
  storage: OccurrenceMutationOutboxStorage,
) {
  try {
    return parseOccurrenceMutationOutbox(
      storage.getItem(OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY),
    );
  } catch {
    return {
      entries: [],
      error: "This browser would not open the saved workout-item queue.",
    };
  }
}

function write(
  storage: OccurrenceMutationOutboxStorage,
  entries: OccurrenceMutationOutboxEntry[],
) {
  storage.setItem(
    OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY,
    JSON.stringify({ version: 1, entries: ordered(entries) }),
  );
}

function sameMutation(
  entry: OccurrenceMutationOutboxEntry,
  input: NewOccurrenceMutationOutboxEntry,
) {
  return (
    entry.ownerId === input.ownerId &&
    entry.sessionId === input.sessionId &&
    entry.occurrenceId === input.occurrenceId &&
    entry.expectedRevision === input.expectedRevision &&
    entry.operation === input.operation &&
    entry.reason === input.reason &&
    entry.note === input.note
  );
}

export function enqueueOccurrenceMutationOutboxEntry(
  storage: OccurrenceMutationOutboxStorage,
  input: NewOccurrenceMutationOutboxEntry,
): MutationResult {
  const current = readOccurrenceMutationOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const existing = current.entries.find(
    (entry) => entry.clientKey === input.clientKey,
  );
  if (existing) {
    return sameMutation(existing, input)
      ? { ok: true, entry: existing }
      : {
          ok: false,
          reason:
            "That workout-item identity already belongs to a different change.",
        };
  }
  if (
    current.entries.length >= OCCURRENCE_MUTATION_OUTBOX_MAX_ENTRIES
  ) {
    return {
      ok: false,
      reason:
        "The workout-item queue is full. Retry or discard an older change first.",
    };
  }
  const entry: OccurrenceMutationOutboxEntry = {
    ...input,
    // The label is device-only presentation metadata. It must never make an
    // otherwise valid durable mutation impossible to retain.
    label: normalizeOccurrenceMutationDisplayLabel(input.label),
    status: "queued",
    attemptCount: 0,
    nextAttemptAtISO: null,
    lastAttemptAtISO: null,
    lastError: null,
  };
  if (!isEntry(entry)) {
    return {
      ok: false,
      reason: "The workout-item change could not be stored safely.",
    };
  }
  try {
    write(storage, [...current.entries, entry]);
    return { ok: true, entry };
  } catch {
    return {
      ok: false,
      reason: "This browser could not retain the workout-item change safely.",
    };
  }
}

function replaceEntry(
  storage: OccurrenceMutationOutboxStorage,
  clientKey: string,
  update: (
    entry: OccurrenceMutationOutboxEntry,
  ) => OccurrenceMutationOutboxEntry,
): MutationResult {
  const current = readOccurrenceMutationOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const index = current.entries.findIndex(
    (entry) => entry.clientKey === clientKey,
  );
  if (index < 0) return { ok: true, entry: null };
  const entry = update(current.entries[index]);
  if (!isEntry(entry)) {
    return { ok: false, reason: "The workout-item queue update was invalid." };
  }
  const entries = [...current.entries];
  entries[index] = entry;
  try {
    write(storage, entries);
    return { ok: true, entry };
  } catch {
    return { ok: false, reason: "This browser could not update the queue." };
  }
}

export function markOccurrenceMutationTransientFailure(
  storage: OccurrenceMutationOutboxStorage,
  clientKey: string,
  reason: string,
  now = new Date(),
) {
  return replaceEntry(storage, clientKey, (entry) => {
    const attemptCount = entry.attemptCount + 1;
    const paused =
      attemptCount >= OCCURRENCE_MUTATION_OUTBOX_MAX_AUTO_ATTEMPTS;
    return {
      ...entry,
      status: paused ? "needs_attention" : "queued",
      attemptCount,
      nextAttemptAtISO: paused
        ? null
        : new Date(
            now.getTime() + occurrenceMutationRetryDelayMs(attemptCount),
          ).toISOString(),
      lastAttemptAtISO: now.toISOString(),
      lastError: paused
        ? "Automatic retry paused after repeated connection failures."
        : reason.slice(0, 500),
    };
  });
}

export function markOccurrenceMutationNeedsAttention(
  storage: OccurrenceMutationOutboxStorage,
  clientKey: string,
  reason: string,
  now = new Date(),
) {
  return replaceEntry(storage, clientKey, (entry) => ({
    ...entry,
    status: "needs_attention",
    attemptCount: entry.attemptCount + 1,
    nextAttemptAtISO: null,
    lastAttemptAtISO: now.toISOString(),
    lastError: reason.slice(0, 500),
  }));
}

export function retryOccurrenceMutationOutboxEntry(
  storage: OccurrenceMutationOutboxStorage,
  clientKey: string,
) {
  return replaceEntry(storage, clientKey, (entry) => ({
    ...entry,
    status: "queued",
    attemptCount: 0,
    nextAttemptAtISO: null,
    lastError: null,
  }));
}

export function removeOccurrenceMutationOutboxEntry(
  storage: OccurrenceMutationOutboxStorage,
  clientKey: string,
): MutationResult {
  const current = readOccurrenceMutationOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  try {
    write(
      storage,
      current.entries.filter((item) => item.clientKey !== clientKey),
    );
    return { ok: true, entry };
  } catch {
    return { ok: false, reason: "This browser could not remove the change." };
  }
}

export function removeOccurrenceMutationOutboxEntryForOwner(
  storage: OccurrenceMutationOutboxStorage,
  ownerId: string,
  clientKey: string,
): MutationResult {
  const current = readOccurrenceMutationOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  if (entry.ownerId !== ownerId) {
    return {
      ok: false,
      reason: "The saved workout-item change now belongs to a different account.",
    };
  }
  return removeOccurrenceMutationOutboxEntry(storage, clientKey);
}

export function releaseOccurrenceMutationBackoffForOwner(
  storage: OccurrenceMutationOutboxStorage,
  ownerId: string,
): MutationResult {
  const current = readOccurrenceMutationOutbox(storage);
  if (current.error) return { ok: false, reason: current.error };
  try {
    write(
      storage,
      current.entries.map((entry) =>
        entry.ownerId === ownerId && entry.status === "queued"
          ? { ...entry, nextAttemptAtISO: null }
          : entry,
      ),
    );
    return { ok: true, entry: null } as MutationResult;
  } catch {
    return { ok: false, reason: "This browser could not release the retry delay." };
  }
}

export function nextOccurrenceMutationOutboxEntry(
  entries: OccurrenceMutationOutboxEntry[],
  ownerId: string,
  now = new Date(),
) {
  const blockedOccurrences = new Set<string>();
  for (const entry of ordered(entries)) {
    if (entry.ownerId !== ownerId || blockedOccurrences.has(entry.occurrenceId)) {
      continue;
    }
    if (
      entry.status === "queued" &&
      (!entry.nextAttemptAtISO ||
        Date.parse(entry.nextAttemptAtISO) <= now.getTime())
    ) {
      return entry;
    }
    blockedOccurrences.add(entry.occurrenceId);
  }
  return null;
}

export function occurrenceMutationRetryDelayMs(attemptCount: number) {
  const delays = [1_000, 3_000, 10_000, 30_000, 120_000, 300_000];
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
}

function browserStorage(): OccurrenceMutationOutboxStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function notifyChange() {
  cachedRaw = undefined;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(OCCURRENCE_MUTATION_OUTBOX_CHANGE_EVENT));
  }
}

export async function withOccurrenceMutationOutboxLock<T>(
  task: () => T | Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      OCCURRENCE_MUTATION_OUTBOX_LOCK_NAME,
      { mode: "exclusive" },
      task,
    );
  }
  return task();
}

function mutateBrowser(
  mutation: (storage: OccurrenceMutationOutboxStorage) => MutationResult,
) {
  const storage = browserStorage();
  if (!storage) {
    return Promise.resolve({
      ok: false as const,
      reason: "This browser could not retain the workout-item change safely.",
    });
  }
  return withOccurrenceMutationOutboxLock(() => {
    const result = mutation(storage);
    if (result.ok) notifyChange();
    return result;
  });
}

function mutateBrowserUnlocked(
  mutation: (storage: OccurrenceMutationOutboxStorage) => MutationResult,
) {
  const storage = browserStorage();
  if (!storage) {
    return {
      ok: false as const,
      reason: "This browser could not retain the workout-item change safely.",
    };
  }
  const result = mutation(storage);
  if (result.ok) notifyChange();
  return result;
}

export function enqueueOccurrenceMutation(
  input: NewOccurrenceMutationOutboxEntry,
) {
  return mutateBrowser((storage) =>
    enqueueOccurrenceMutationOutboxEntry(storage, input),
  );
}

export function markOccurrenceMutationTransientFailureUnlocked(
  clientKey: string,
  reason: string,
) {
  return mutateBrowserUnlocked((storage) =>
    markOccurrenceMutationTransientFailure(storage, clientKey, reason),
  );
}

export function markOccurrenceMutationNeedsAttentionUnlocked(
  clientKey: string,
  reason: string,
) {
  return mutateBrowserUnlocked((storage) =>
    markOccurrenceMutationNeedsAttention(storage, clientKey, reason),
  );
}

export function retryOccurrenceMutation(clientKey: string) {
  return mutateBrowser((storage) =>
    retryOccurrenceMutationOutboxEntry(storage, clientKey),
  );
}

export function removeOccurrenceMutation(clientKey: string) {
  return mutateBrowser((storage) =>
    removeOccurrenceMutationOutboxEntry(storage, clientKey),
  );
}

export function removeOccurrenceMutationForOwner(
  ownerId: string,
  clientKey: string,
) {
  return mutateBrowser((storage) =>
    removeOccurrenceMutationOutboxEntryForOwner(storage, ownerId, clientKey),
  );
}

export function removeOccurrenceMutationUnlocked(clientKey: string) {
  return mutateBrowserUnlocked((storage) =>
    removeOccurrenceMutationOutboxEntry(storage, clientKey),
  );
}

export function releaseOccurrenceMutationBackoff(ownerId: string) {
  return mutateBrowser((storage) =>
    releaseOccurrenceMutationBackoffForOwner(storage, ownerId),
  );
}

export function discardUnreadableOccurrenceMutationOutbox() {
  const storage = browserStorage();
  if (!storage) {
    return { ok: false as const, reason: "This browser could not open the queue." };
  }
  try {
    storage.removeItem(OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY);
    notifyChange();
    return { ok: true as const };
  } catch {
    return { ok: false as const, reason: "This browser could not discard the queue." };
  }
}

export function getOccurrenceMutationOutboxSnapshot() {
  const storage = browserStorage();
  if (!storage) return EMPTY_SNAPSHOT;
  let raw: string | null;
  try {
    raw = storage.getItem(OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY);
  } catch {
    return {
      entries: [],
      error: "This browser would not open the saved workout-item queue.",
    };
  }
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;
  cachedSnapshot = parseOccurrenceMutationOutbox(raw);
  return cachedSnapshot;
}

export function getOccurrenceMutationOutboxServerSnapshot() {
  return EMPTY_SNAPSHOT;
}

export function subscribeToOccurrenceMutationOutbox(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY) {
      cachedRaw = undefined;
      onChange();
    }
  };
  const onLocal = () => {
    cachedRaw = undefined;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(OCCURRENCE_MUTATION_OUTBOX_CHANGE_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(OCCURRENCE_MUTATION_OUTBOX_CHANGE_EVENT, onLocal);
  };
}

function getStatusChannel() {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return null;
  }
  statusChannel ??= new BroadcastChannel(STATUS_CHANNEL_NAME);
  return statusChannel;
}

export function publishOccurrenceMutationOutboxEvent(
  detail: OccurrenceMutationOutboxClientEvent,
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OccurrenceMutationOutboxClientEvent>(
      OCCURRENCE_MUTATION_OUTBOX_STATUS_EVENT,
      { detail },
    ),
  );
  getStatusChannel()?.postMessage(detail);
}

export function subscribeToOccurrenceMutationOutboxStatus(
  listener: (detail: OccurrenceMutationOutboxClientEvent) => void,
) {
  if (typeof window === "undefined") return () => undefined;
  const onWindow = (event: Event) => {
    listener(
      (event as CustomEvent<OccurrenceMutationOutboxClientEvent>).detail,
    );
  };
  const channel = getStatusChannel();
  const onChannel = (event: MessageEvent<OccurrenceMutationOutboxClientEvent>) =>
    listener(event.data);
  window.addEventListener(OCCURRENCE_MUTATION_OUTBOX_STATUS_EVENT, onWindow);
  channel?.addEventListener("message", onChannel);
  return () => {
    window.removeEventListener(OCCURRENCE_MUTATION_OUTBOX_STATUS_EVENT, onWindow);
    channel?.removeEventListener("message", onChannel);
  };
}
