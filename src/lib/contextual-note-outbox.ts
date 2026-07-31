import {
  contextualNoteCreateInputSchema,
  type ContextualNoteCreateInput,
} from "@/lib/contextual-note-contract";

export const CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY =
  "workout-tracker:contextual-note-outbox:v1";
export const CONTEXTUAL_NOTE_OUTBOX_LOCK_NAME =
  "workout-tracker:contextual-note-outbox";
export const CONTEXTUAL_NOTE_OUTBOX_CHANGE_EVENT =
  "contextual-note-outbox-change";
export const CONTEXTUAL_NOTE_OUTBOX_CHANNEL =
  "contextual-note-outbox-change-v1";
export const CONTEXTUAL_NOTE_OUTBOX_MAX_ENTRIES = 100;
export const CONTEXTUAL_NOTE_OUTBOX_MAX_AUTO_ATTEMPTS = 6;

export type ContextualNoteOutboxStatus =
  | "queued"
  | "syncing"
  | "needs_attention";

export type ContextualNotePayload = ContextualNoteCreateInput;

export type ContextualNoteOutboxEntry = {
  clientKey: string;
  ownerId: string;
  payload: ContextualNotePayload;
  payloadHash: string;
  createdAtISO: string;
  status: ContextualNoteOutboxStatus;
  attemptCount: number;
  nextAttemptAtISO: string | null;
  lastAttemptAtISO: string | null;
  syncStartedAtISO: string | null;
  lastError: string | null;
};

export type NewContextualNoteOutboxEntry = Pick<
  ContextualNoteOutboxEntry,
  "clientKey" | "ownerId" | "payload" | "createdAtISO"
>;

export type ContextualNoteQuarantinedEntry = {
  quarantineKey: string;
  raw: unknown;
  reason: string;
};

export type ContextualNoteOutboxSnapshot = {
  ownerId: string;
  entries: ContextualNoteOutboxEntry[];
  quarantined: ContextualNoteQuarantinedEntry[];
  error: string | null;
};

export type ContextualNoteOutboxStorage = Pick<
  Storage,
  "getItem" | "setItem"
>;

export type ContextualNoteOutboxMutationResult =
  | { ok: true; entry: ContextualNoteOutboxEntry | null }
  | { ok: false; reason: string };

type StoredQuarantinedEntry = {
  quarantine: "contextual-note-outbox-entry-v1";
  raw: unknown;
  reason:
    | "This saved note is incomplete or invalid."
    | "This saved note has an invalid or changed payload hash."
    | "This saved note repeats an earlier identity.";
};

type OutboxEnvelope = {
  version: 1;
  ownerId: string;
  entries: unknown[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ENTRY_KEYS = [
  "clientKey",
  "ownerId",
  "payload",
  "payloadHash",
  "createdAtISO",
  "status",
  "attemptCount",
  "nextAttemptAtISO",
  "lastAttemptAtISO",
  "syncStartedAtISO",
  "lastError",
] as const;
const QUARANTINE_REASONS: StoredQuarantinedEntry["reason"][] = [
  "This saved note is incomplete or invalid.",
  "This saved note has an invalid or changed payload hash.",
  "This saved note repeats an earlier identity.",
];

let cachedOwnerId: string | undefined;
let cachedRaw: string | null | undefined;
let cachedSnapshot: ContextualNoteOutboxSnapshot | undefined;
const serverSnapshots = new Map<string, ContextualNoteOutboxSnapshot>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || isDate(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function hasSameRawValue(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function parseContextualNotePayload(value: unknown): ContextualNotePayload | null {
  const parsed = contextualNoteCreateInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

// A small, dependency-free SHA-256 keeps validation synchronous during storage reads.
function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
    0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
    0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
    0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  const rotate = (word: number, bits: number) =>
    (word >>> bits) | (word << (32 - bits));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + s1 + choice + constants[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function hashContextualNotePayload(payload: ContextualNotePayload) {
  return `sha256:${sha256(canonicalJson(payload))}`;
}

function isEntry(value: unknown, ownerId: string): value is ContextualNoteOutboxEntry {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) return false;
  const payload = parseContextualNotePayload(value.payload);
  if (!payload || payload.clientKey !== value.clientKey) return false;
  return (
    isUuid(value.clientKey) &&
    value.ownerId === ownerId &&
    isUuid(value.ownerId) &&
    typeof value.payloadHash === "string" &&
    HASH_PATTERN.test(value.payloadHash) &&
    isDate(value.createdAtISO) &&
    ["queued", "syncing", "needs_attention"].includes(value.status as string) &&
    typeof value.attemptCount === "number" &&
    Number.isInteger(value.attemptCount) &&
    value.attemptCount >= 0 &&
    isNullableDate(value.nextAttemptAtISO) &&
    isNullableDate(value.lastAttemptAtISO) &&
    isNullableDate(value.syncStartedAtISO) &&
    ((value.status === "syncing" && value.syncStartedAtISO !== null) ||
      (value.status !== "syncing" && value.syncStartedAtISO === null)) &&
    (value.status === "queued" || value.nextAttemptAtISO === null) &&
    (value.lastError === null ||
      (typeof value.lastError === "string" && value.lastError.length <= 500))
  );
}

function isStoredQuarantine(value: unknown): value is StoredQuarantinedEntry {
  return (
    isRecord(value) &&
    value.quarantine === "contextual-note-outbox-entry-v1" &&
    Object.hasOwn(value, "raw") &&
    QUARANTINE_REASONS.includes(value.reason as StoredQuarantinedEntry["reason"])
  );
}

function emptySnapshot(ownerId: string): ContextualNoteOutboxSnapshot {
  return { ownerId, entries: [], quarantined: [], error: null };
}

export function parseContextualNoteOutbox(
  raw: string | null,
  ownerId: string
): ContextualNoteOutboxSnapshot {
  if (!isUuid(ownerId)) {
    return { ...emptySnapshot(ownerId), error: "The note outbox owner is invalid." };
  }
  if (raw == null || raw === "") return emptySnapshot(ownerId);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      ...emptySnapshot(ownerId),
      error: "The saved note outbox could not be read. It was left unchanged.",
    };
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "ownerId", "entries"]) ||
    value.version !== 1 ||
    value.ownerId !== ownerId ||
    !Array.isArray(value.entries)
  ) {
    return {
      ...emptySnapshot(ownerId),
      error:
        "The saved note outbox belongs to another account or uses an unsupported format. It was left unchanged.",
    };
  }
  const entries: ContextualNoteOutboxEntry[] = [];
  const quarantined: ContextualNoteQuarantinedEntry[] = [];
  const keys = new Set<string>();
  value.entries.forEach((rawEntry, storageIndex) => {
    if (isStoredQuarantine(rawEntry)) {
      quarantined.push({
        quarantineKey: `quarantined:${storageIndex}`,
        raw: rawEntry.raw,
        reason: rawEntry.reason,
      });
      return;
    }
    if (!isEntry(rawEntry, ownerId)) {
      quarantined.push({
        quarantineKey: `entries:${storageIndex}`,
        raw: rawEntry,
        reason: "This saved note is incomplete or invalid.",
      });
      return;
    }
    const parsedPayload = parseContextualNotePayload(rawEntry.payload);
    if (
      !parsedPayload ||
      rawEntry.payloadHash !== hashContextualNotePayload(parsedPayload)
    ) {
      quarantined.push({
        quarantineKey: `entries:${storageIndex}`,
        raw: rawEntry,
        reason: "This saved note has an invalid or changed payload hash.",
      });
      return;
    }
    if (keys.has(rawEntry.clientKey)) {
      quarantined.push({
        quarantineKey: `entries:${storageIndex}`,
        raw: rawEntry,
        reason: "This saved note repeats an earlier identity.",
      });
      return;
    }
    keys.add(rawEntry.clientKey);
    entries.push(rawEntry);
  });
  entries.sort(
    (left, right) =>
      Date.parse(left.createdAtISO) - Date.parse(right.createdAtISO) ||
      left.clientKey.localeCompare(right.clientKey)
  );
  return { ownerId, entries, quarantined, error: null };
}

export function readContextualNoteOutbox(
  storage: ContextualNoteOutboxStorage,
  ownerId: string
) {
  try {
    return parseContextualNoteOutbox(
      storage.getItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY),
      ownerId
    );
  } catch {
    return {
      ...emptySnapshot(ownerId),
      error: "This browser would not open the note outbox. Nothing was sent.",
    };
  }
}

function writeOutbox(
  storage: ContextualNoteOutboxStorage,
  ownerId: string,
  entries: ContextualNoteOutboxEntry[],
  quarantined: ContextualNoteQuarantinedEntry[]
) {
  const envelope: OutboxEnvelope = {
    version: 1,
    ownerId,
    entries: [
      ...entries,
      ...quarantined.map(
        ({ raw, reason }): StoredQuarantinedEntry => ({
          quarantine: "contextual-note-outbox-entry-v1",
          raw,
          reason: reason as StoredQuarantinedEntry["reason"],
        })
      ),
    ],
  };
  storage.setItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY, JSON.stringify(envelope));
}

export function enqueueContextualNoteOutboxEntry(
  storage: ContextualNoteOutboxStorage,
  input: NewContextualNoteOutboxEntry
): ContextualNoteOutboxMutationResult {
  const current = readContextualNoteOutbox(storage, input.ownerId);
  if (current.error) return { ok: false, reason: current.error };
  const payload = parseContextualNotePayload(input.payload);
  if (!payload || payload.clientKey !== input.clientKey) {
    return { ok: false, reason: "The note could not be prepared for safe device storage." };
  }
  const payloadHash = hashContextualNotePayload(payload);
  const existing = current.entries.find((entry) => entry.clientKey === input.clientKey);
  if (existing) {
    return existing.payloadHash === payloadHash && existing.createdAtISO === input.createdAtISO
      ? { ok: true, entry: existing }
      : {
          ok: false,
          reason: "That note identity already belongs to different content.",
        };
  }
  if (current.entries.length + current.quarantined.length >= CONTEXTUAL_NOTE_OUTBOX_MAX_ENTRIES) {
    return {
      ok: false,
      reason: "The note outbox is full. Recover or remove an older note before adding another.",
    };
  }
  const entry: ContextualNoteOutboxEntry = {
    clientKey: input.clientKey,
    ownerId: input.ownerId,
    payload,
    payloadHash,
    createdAtISO: input.createdAtISO,
    status: "queued",
    attemptCount: 0,
    nextAttemptAtISO: null,
    lastAttemptAtISO: null,
    syncStartedAtISO: null,
    lastError: null,
  };
  if (!isEntry(entry, input.ownerId)) {
    return { ok: false, reason: "The note could not be prepared for safe device storage." };
  }
  try {
    writeOutbox(storage, input.ownerId, [...current.entries, entry], current.quarantined);
    return { ok: true, entry };
  } catch {
    return {
      ok: false,
      reason: "This browser could not retain the note safely. Nothing was sent.",
    };
  }
}

function replaceEntry(
  storage: ContextualNoteOutboxStorage,
  ownerId: string,
  clientKey: string,
  expectedPayloadHash: string,
  replace: (entry: ContextualNoteOutboxEntry) => ContextualNoteOutboxEntry
): ContextualNoteOutboxMutationResult {
  const current = readContextualNoteOutbox(storage, ownerId);
  if (current.error) return { ok: false, reason: current.error };
  const index = current.entries.findIndex((entry) => entry.clientKey === clientKey);
  if (index < 0) return { ok: true, entry: null };
  const prior = current.entries[index];
  if (prior.payloadHash !== expectedPayloadHash) {
    return { ok: false, reason: "The saved note changed. Review it before continuing." };
  }
  const entry = replace(prior);
  if (
    entry.clientKey !== prior.clientKey ||
    entry.ownerId !== prior.ownerId ||
    entry.createdAtISO !== prior.createdAtISO ||
    entry.payloadHash !== prior.payloadHash ||
    canonicalJson(entry.payload) !== canonicalJson(prior.payload) ||
    !isEntry(entry, ownerId)
  ) {
    return { ok: false, reason: "The queued note update was invalid." };
  }
  const entries = [...current.entries];
  entries[index] = entry;
  try {
    writeOutbox(storage, ownerId, entries, current.quarantined);
    return { ok: true, entry };
  } catch {
    return { ok: false, reason: "This browser could not update the saved note." };
  }
}

export function markContextualNoteOutboxSyncing(
  storage: ContextualNoteOutboxStorage,
  ownerId: string,
  clientKey: string,
  expectedPayloadHash: string,
  now = new Date()
) {
  return replaceEntry(storage, ownerId, clientKey, expectedPayloadHash, (entry) => ({
    ...entry,
    status: "syncing",
    syncStartedAtISO: now.toISOString(),
    lastAttemptAtISO: now.toISOString(),
    nextAttemptAtISO: null,
    lastError: null,
  }));
}

export function contextualNoteRetryDelayMs(attemptCount: number) {
  const delays = [1_000, 3_000, 10_000, 30_000, 120_000, 300_000];
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
}

export function markContextualNoteOutboxTransientFailure(
  storage: ContextualNoteOutboxStorage,
  ownerId: string,
  clientKey: string,
  expectedPayloadHash: string,
  reason: string,
  now = new Date()
) {
  return replaceEntry(storage, ownerId, clientKey, expectedPayloadHash, (entry) => {
    const attemptCount = entry.attemptCount + 1;
    const paused = attemptCount >= CONTEXTUAL_NOTE_OUTBOX_MAX_AUTO_ATTEMPTS;
    return {
      ...entry,
      status: paused ? "needs_attention" : "queued",
      attemptCount,
      syncStartedAtISO: null,
      lastAttemptAtISO: now.toISOString(),
      nextAttemptAtISO: paused
        ? null
        : new Date(now.getTime() + contextualNoteRetryDelayMs(attemptCount)).toISOString(),
      lastError: paused
        ? "Automatic retry paused after repeated connection failures. Try again when ready."
        : reason.slice(0, 500),
    };
  });
}

export function markContextualNoteOutboxNeedsAttention(
  storage: ContextualNoteOutboxStorage,
  ownerId: string,
  clientKey: string,
  expectedPayloadHash: string,
  reason: string,
  now = new Date()
) {
  return replaceEntry(storage, ownerId, clientKey, expectedPayloadHash, (entry) => ({
    ...entry,
    status: "needs_attention",
    attemptCount: entry.attemptCount + 1,
    syncStartedAtISO: null,
    nextAttemptAtISO: null,
    lastAttemptAtISO: now.toISOString(),
    lastError: reason.slice(0, 500),
  }));
}

export function retryContextualNoteOutboxEntry(
  storage: ContextualNoteOutboxStorage,
  ownerId: string,
  clientKey: string,
  expectedPayloadHash: string
) {
  return replaceEntry(storage, ownerId, clientKey, expectedPayloadHash, (entry) => ({
    ...entry,
    status: "queued",
    attemptCount: 0,
    syncStartedAtISO: null,
    nextAttemptAtISO: null,
    lastError: null,
  }));
}

export function removeContextualNoteOutboxEntry(
  storage: ContextualNoteOutboxStorage,
  ownerId: string,
  clientKey: string,
  expectedPayloadHash: string
): ContextualNoteOutboxMutationResult {
  const current = readContextualNoteOutbox(storage, ownerId);
  if (current.error) return { ok: false, reason: current.error };
  const entry = current.entries.find((item) => item.clientKey === clientKey);
  if (!entry) return { ok: true, entry: null };
  if (entry.payloadHash !== expectedPayloadHash) {
    return { ok: false, reason: "The saved note changed. Review it before removing it." };
  }
  try {
    writeOutbox(
      storage,
      ownerId,
      current.entries.filter((item) => item.clientKey !== clientKey),
      current.quarantined
    );
    return { ok: true, entry };
  } catch {
    return { ok: false, reason: "This browser could not remove the saved note." };
  }
}

export function discardContextualNoteQuarantinedEntry(
  storage: ContextualNoteOutboxStorage,
  ownerId: string,
  quarantineKey: string,
  expectedRaw: unknown
): ContextualNoteOutboxMutationResult {
  const current = readContextualNoteOutbox(storage, ownerId);
  if (current.error) return { ok: false, reason: current.error };
  const selected = current.quarantined.find(
    (entry) => entry.quarantineKey === quarantineKey
  );
  if (!selected || !hasSameRawValue(selected.raw, expectedRaw)) {
    return {
      ok: false,
      reason:
        "The unreadable saved note changed before removal. Review the outbox again.",
    };
  }
  try {
    writeOutbox(
      storage,
      ownerId,
      current.entries,
      current.quarantined.filter(
        (entry) => entry.quarantineKey !== quarantineKey
      )
    );
    return { ok: true, entry: null };
  } catch {
    return {
      ok: false,
      reason: "This browser could not remove the unreadable saved note.",
    };
  }
}

function browserStorage(): ContextualNoteOutboxStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function notifyChange(ownerId: string) {
  cachedRaw = undefined;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CONTEXTUAL_NOTE_OUTBOX_CHANGE_EVENT, { detail: { ownerId } }));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CONTEXTUAL_NOTE_OUTBOX_CHANNEL);
    channel.postMessage({ version: 1, ownerId });
    channel.close();
  }
}

export async function withContextualNoteOutboxLock<T>(task: () => T | Promise<T>) {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      CONTEXTUAL_NOTE_OUTBOX_LOCK_NAME,
      { mode: "exclusive" },
      task
    );
  }
  throw new Error(
    "Safe cross-tab note coordination is unavailable in this browser."
  );
}

export async function mutateContextualNoteOutboxInBrowser(
  ownerId: string,
  mutation: (storage: ContextualNoteOutboxStorage) => ContextualNoteOutboxMutationResult
) {
  const storage = browserStorage();
  if (!storage) {
    return { ok: false as const, reason: "This browser could not retain the note safely. Nothing was sent." };
  }
  if (typeof navigator === "undefined" || !navigator.locks) {
    return {
      ok: false as const,
      reason:
        "This browser cannot safely coordinate saved notes across tabs. Nothing was saved or sent.",
    };
  }
  return withContextualNoteOutboxLock(() => {
    const result = mutation(storage);
    if (result.ok) notifyChange(ownerId);
    return result;
  });
}

/** Use only while an outer `withContextualNoteOutboxLock` owns the drain. */
export function mutateContextualNoteOutboxInBrowserUnlocked(
  ownerId: string,
  mutation: (storage: ContextualNoteOutboxStorage) => ContextualNoteOutboxMutationResult
) {
  const storage = browserStorage();
  if (!storage) {
    return {
      ok: false as const,
      reason: "This browser could not retain the note safely. Nothing was sent.",
    };
  }
  const result = mutation(storage);
  if (result.ok) notifyChange(ownerId);
  return result;
}

export function enqueueContextualNote(input: NewContextualNoteOutboxEntry) {
  return mutateContextualNoteOutboxInBrowser(input.ownerId, (storage) =>
    enqueueContextualNoteOutboxEntry(storage, input)
  );
}

export function beginContextualNoteSync(
  ownerId: string,
  clientKey: string,
  expectedPayloadHash: string,
  now = new Date()
) {
  return mutateContextualNoteOutboxInBrowser(ownerId, (storage) =>
    markContextualNoteOutboxSyncing(
      storage,
      ownerId,
      clientKey,
      expectedPayloadHash,
      now
    )
  );
}

export function retryContextualNote(
  ownerId: string,
  clientKey: string,
  expectedPayloadHash: string
) {
  return mutateContextualNoteOutboxInBrowser(ownerId, (storage) =>
    retryContextualNoteOutboxEntry(
      storage,
      ownerId,
      clientKey,
      expectedPayloadHash
    )
  );
}

export function removeContextualNote(
  ownerId: string,
  clientKey: string,
  expectedPayloadHash: string
) {
  return mutateContextualNoteOutboxInBrowser(ownerId, (storage) =>
    removeContextualNoteOutboxEntry(
      storage,
      ownerId,
      clientKey,
      expectedPayloadHash
    )
  );
}

export function discardContextualNoteQuarantined(
  ownerId: string,
  quarantineKey: string,
  expectedRaw: unknown
) {
  return mutateContextualNoteOutboxInBrowser(ownerId, (storage) =>
    discardContextualNoteQuarantinedEntry(
      storage,
      ownerId,
      quarantineKey,
      expectedRaw
    )
  );
}

export function getContextualNoteOutboxSnapshot(ownerId: string) {
  const storage = browserStorage();
  if (!storage) return emptySnapshot(ownerId);
  let raw: string | null;
  try {
    raw = storage.getItem(CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY);
  } catch {
    return { ...emptySnapshot(ownerId), error: "This browser would not open the note outbox." };
  }
  if (cachedOwnerId === ownerId && cachedRaw === raw && cachedSnapshot) return cachedSnapshot;
  cachedOwnerId = ownerId;
  cachedRaw = raw;
  cachedSnapshot = parseContextualNoteOutbox(raw, ownerId);
  return cachedSnapshot;
}

export function getContextualNoteOutboxServerSnapshot(ownerId: string) {
  const existing = serverSnapshots.get(ownerId);
  if (existing) return existing;
  const snapshot = emptySnapshot(ownerId);
  serverSnapshots.set(ownerId, snapshot);
  return snapshot;
}

export function subscribeToContextualNoteOutbox(ownerId: string, onStoreChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const changed = () => {
    cachedRaw = undefined;
    onStoreChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CONTEXTUAL_NOTE_OUTBOX_STORAGE_KEY) changed();
  };
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<{ ownerId?: unknown }>).detail;
    if (detail?.ownerId === ownerId) changed();
  };
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(CONTEXTUAL_NOTE_OUTBOX_CHANNEL);
  const onBroadcast = (event: MessageEvent<unknown>) => {
    if (isRecord(event.data) && event.data.version === 1 && event.data.ownerId === ownerId) changed();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CONTEXTUAL_NOTE_OUTBOX_CHANGE_EVENT, onLocal);
  channel?.addEventListener("message", onBroadcast);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CONTEXTUAL_NOTE_OUTBOX_CHANGE_EVENT, onLocal);
    channel?.removeEventListener("message", onBroadcast);
    channel?.close();
  };
}

export type ContextualNoteDictationDecision =
  | { type: "cancel" | "discard" }
  | {
      type: "confirm";
      reviewed: true;
      clientKey: string;
      reviewedTranscript: string;
    };

export function confirmedContextualNoteDictation(decision: unknown): {
  clientKey: string;
  body: string;
  inputMode: "reviewed_dictation";
} | null {
  if (!isRecord(decision)) return null;
  if (
    (decision.type === "cancel" || decision.type === "discard") &&
    hasExactKeys(decision, ["type"])
  ) {
    return null;
  }
  if (
    decision.type !== "confirm" ||
    decision.reviewed !== true ||
    !hasExactKeys(decision, ["type", "reviewed", "clientKey", "reviewedTranscript"]) ||
    !isUuid(decision.clientKey) ||
    typeof decision.reviewedTranscript !== "string"
  ) {
    return null;
  }
  const transcript = decision.reviewedTranscript.trim();
  if (transcript.length < 1 || transcript.length > 5_000) return null;
  return { clientKey: decision.clientKey, body: transcript, inputMode: "reviewed_dictation" };
}
