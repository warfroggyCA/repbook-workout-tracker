import { createClientUuid } from "@/lib/client-uuid";

export const REST_TIMER_STORAGE_KEY = "workout-tracker:rest-timer:v1";
export const REST_TIMER_CHANGE_EVENT = "workout-rest-timer-change";
export const REST_TIMER_LOCK_NAME = "workout-tracker:rest-timer-lock:v1";

export type RestCueMilestone = "15" | "10" | "complete";
export type RestTimerPhase = "running" | "ready" | "skipped" | "continued";
export type RestCompletionContext = "foreground" | "while_away";
export type RestCueChannelOutcome =
  | "not_requested"
  | "requested"
  | "blocked"
  | "unavailable";
export type RestCueOutcome = {
  sound: RestCueChannelOutcome;
  vibration: RestCueChannelOutcome;
  completion:
    | "not_due"
    | "requested"
    | "blocked"
    | "unavailable"
    | "missed_while_away";
};

export type DurableRestTimer = {
  version: 1;
  generationId: string;
  revision: number;
  ownerId: string;
  sessionId: string;
  /** Device-observed start. `endsAt` remains the countdown source of truth. */
  startedAt: number;
  /** Exact device command and, once acknowledged, server result for this rest. */
  sourceSessionExerciseId: string | null;
  sourceOccurrenceId: string | null;
  sourceClientKey: string | null;
  sourceCompletedSetId: string | null;
  phase: RestTimerPhase;
  endsAt: number;
  totalSec: number;
  readyAt: number | null;
  completionContext: RestCompletionContext | null;
  completionCueOutcome: RestCueOutcome | null;
  attemptedMilestones: RestCueMilestone[];
};

export type RestTimerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type RestTimerRestoreResult =
  | { status: "empty"; timer: null }
  | { status: "invalid"; timer: null }
  | { status: "foreign"; timer: null }
  | { status: "restored"; timer: DurableRestTimer };

export type RestTimerIdentity = { ownerId: string; sessionId: string };
export type RestTimerCasResult =
  | { status: "updated"; timer: DurableRestTimer }
  | { status: "unchanged"; timer: DurableRestTimer }
  | { status: "empty" | "invalid" | "foreign" | "stale" | "storage_error"; timer: null };

export type RestCueClaimResult = RestTimerCasResult & {
  claimedMilestones: RestCueMilestone[];
};

export type RestTimerForegroundCompletionResult =
  | { status: "completed"; timer: DurableRestTimer; cueOwned: true }
  | { status: "unchanged"; timer: DurableRestTimer; cueOwned: false }
  | {
      status: "empty" | "invalid" | "foreign" | "stale" | "storage_error";
      timer: null;
      cueOwned: false;
    };

export type RestTimerStoredAdjustmentResult =
  | { status: "updated"; timer: DurableRestTimer; cueOwned: false }
  | { status: "completed"; timer: DurableRestTimer; cueOwned: true }
  | { status: "unchanged"; timer: DurableRestTimer; cueOwned: false }
  | {
      status: "empty" | "invalid" | "foreign" | "stale" | "storage_error";
      timer: null;
      cueOwned: false;
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MILESTONES: RestCueMilestone[] = ["15", "10", "complete"];
const LEGACY_TIMER_KEYS = [
  "version",
  "generationId",
  "revision",
  "ownerId",
  "sessionId",
  "phase",
  "endsAt",
  "totalSec",
  "readyAt",
  "completionContext",
  "completionCueOutcome",
  "attemptedMilestones",
] as const;
const PREVIOUS_TIMER_KEYS = [
  ...LEGACY_TIMER_KEYS,
  "sourceSessionExerciseId",
  "sourceOccurrenceId",
  "sourceCompletedSetId",
] as const;
const TIMER_KEYS = [
  ...LEGACY_TIMER_KEYS,
  "startedAt",
  "sourceSessionExerciseId",
  "sourceOccurrenceId",
  "sourceClientKey",
  "sourceCompletedSetId",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isMilestone(value: unknown): value is RestCueMilestone {
  return value === "15" || value === "10" || value === "complete";
}

function isCueOutcome(value: unknown): value is RestCueOutcome {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false;
  const channelOutcomes = [
    "not_requested",
    "requested",
    "blocked",
    "unavailable",
  ];
  return (
    Object.hasOwn(value, "sound") &&
    Object.hasOwn(value, "vibration") &&
    Object.hasOwn(value, "completion") &&
    channelOutcomes.includes(String(value.sound)) &&
    channelOutcomes.includes(String(value.vibration)) &&
    [
      "not_due",
      "requested",
      "blocked",
      "unavailable",
      "missed_while_away",
    ].includes(
      String(value.completion),
    )
  );
}

export function isDurableRestTimer(value: unknown): value is DurableRestTimer {
  if (!isRecord(value) || value.version !== 1) return false;
  if (
    Object.keys(value).length !== TIMER_KEYS.length ||
    !TIMER_KEYS.every((key) => Object.hasOwn(value, key)) ||
    typeof value.generationId !== "string" ||
    !UUID_PATTERN.test(value.generationId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.ownerId !== "string" ||
    !UUID_PATTERN.test(value.ownerId) ||
    typeof value.sessionId !== "string" ||
    !UUID_PATTERN.test(value.sessionId) ||
    typeof value.startedAt !== "number" ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt <= 0 ||
    !["running", "ready", "skipped", "continued"].includes(
      String(value.phase),
    ) ||
    typeof value.endsAt !== "number" ||
    !Number.isSafeInteger(value.endsAt) ||
    value.endsAt <= 0 ||
    value.endsAt < value.startedAt ||
    typeof value.totalSec !== "number" ||
    !Number.isInteger(value.totalSec) ||
    value.totalSec < 1 ||
    value.totalSec > 1800 ||
    (value.readyAt !== null &&
      (typeof value.readyAt !== "number" ||
        !Number.isSafeInteger(value.readyAt) ||
        value.readyAt <= 0)) ||
    (value.completionContext !== null &&
      value.completionContext !== "foreground" &&
      value.completionContext !== "while_away") ||
    (value.completionCueOutcome !== null &&
      !isCueOutcome(value.completionCueOutcome)) ||
    !Array.isArray(value.attemptedMilestones) ||
    !value.attemptedMilestones.every(isMilestone) ||
    new Set(value.attemptedMilestones).size !== value.attemptedMilestones.length
  ) {
    return false;
  }

  const noSource = value.sourceSessionExerciseId === null &&
    value.sourceOccurrenceId === null &&
    value.sourceClientKey === null &&
    value.sourceCompletedSetId === null;
  const associatedSource =
    typeof value.sourceSessionExerciseId === "string" &&
    UUID_PATTERN.test(value.sourceSessionExerciseId) &&
    typeof value.sourceOccurrenceId === "string" &&
    UUID_PATTERN.test(value.sourceOccurrenceId) &&
    (value.sourceClientKey === null ||
      (typeof value.sourceClientKey === "string" &&
        UUID_PATTERN.test(value.sourceClientKey))) &&
    (value.sourceCompletedSetId === null ||
      (typeof value.sourceCompletedSetId === "string" &&
        UUID_PATTERN.test(value.sourceCompletedSetId))) &&
    (value.sourceClientKey !== null || value.sourceCompletedSetId !== null);
  if (!noSource && !associatedSource) return false;

  const phase = value.phase as RestTimerPhase;
  if (phase === "running") {
    return value.readyAt === null &&
      value.completionContext === null &&
      value.completionCueOutcome === null;
  }
  if (phase === "ready") {
    return value.readyAt !== null &&
      value.completionContext !== null &&
      value.completionCueOutcome !== null &&
      value.attemptedMilestones.includes("complete");
  }
  if (phase === "skipped") {
    return value.readyAt !== null &&
      value.completionContext === null &&
      value.completionCueOutcome === null;
  }
  return value.readyAt !== null &&
    ((value.completionContext === null && value.completionCueOutcome === null) ||
      (value.completionContext !== null && value.completionCueOutcome !== null));
}

export function createRestTimer(input: {
  ownerId: string;
  sessionId: string;
  generationId?: string;
  now: number;
  seconds: number;
  sourceSessionExerciseId?: string | null;
  sourceOccurrenceId?: string | null;
  sourceClientKey?: string | null;
  sourceCompletedSetId?: string | null;
}): DurableRestTimer | null {
  let generationId = input.generationId;
  if (generationId == null) {
    try {
      generationId = createClientUuid();
    } catch {
      return null;
    }
  }
  const endsAt = input.now + input.seconds * 1000;
  const sourceSessionExerciseId = input.sourceSessionExerciseId ?? null;
  const sourceOccurrenceId = input.sourceOccurrenceId ?? null;
  const sourceClientKey = input.sourceClientKey ?? null;
  const sourceCompletedSetId = input.sourceCompletedSetId ?? null;
  const sourceIsValid =
    (sourceSessionExerciseId === null && sourceOccurrenceId === null &&
      sourceClientKey === null && sourceCompletedSetId === null) ||
    (typeof sourceSessionExerciseId === "string" &&
      UUID_PATTERN.test(sourceSessionExerciseId) &&
      typeof sourceOccurrenceId === "string" && UUID_PATTERN.test(sourceOccurrenceId) &&
      (sourceClientKey === null || UUID_PATTERN.test(sourceClientKey)) &&
      (sourceCompletedSetId === null || UUID_PATTERN.test(sourceCompletedSetId)) &&
      (sourceClientKey !== null || sourceCompletedSetId !== null));
  if (
    typeof generationId !== "string" ||
    !UUID_PATTERN.test(generationId) ||
    !UUID_PATTERN.test(input.ownerId) ||
    !UUID_PATTERN.test(input.sessionId) ||
    !Number.isSafeInteger(input.now) ||
    input.now <= 0 ||
    !Number.isInteger(input.seconds) ||
    input.seconds < 1 ||
    input.seconds > 1800 ||
    !Number.isSafeInteger(endsAt)
    || !sourceIsValid
  ) {
    return null;
  }
  return {
    version: 1,
    generationId,
    revision: 0,
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    startedAt: input.now,
    sourceSessionExerciseId,
    sourceOccurrenceId,
    sourceClientKey,
    sourceCompletedSetId,
    phase: "running",
    endsAt,
    totalSec: input.seconds,
    readyAt: null,
    completionContext: null,
    completionCueOutcome: null,
    attemptedMilestones: [],
  };
}

export function remainingRestSeconds(timer: DurableRestTimer, now: number) {
  return timer.phase === "running"
    ? Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
    : 0;
}

export function restoreRestTimer(
  raw: string | null,
  identity: RestTimerIdentity,
  now: number,
): RestTimerRestoreResult {
  const parsed = parseStoredRestTimer(raw, identity);
  if (parsed.status !== "restored") return parsed;
  const value = parsed.timer;
  if (value.phase === "running" && now >= value.endsAt) {
    return {
      status: "restored",
      timer: completeRestTimer(value, value.endsAt, "while_away", {
        sound: "not_requested",
        vibration: "not_requested",
        completion: "missed_while_away",
      }),
    };
  }
  return { status: "restored", timer: value };
}

function parseStoredRestTimer(
  raw: string | null,
  identity: RestTimerIdentity,
): RestTimerRestoreResult {
  if (raw == null) return { status: "empty", timer: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "invalid", timer: null };
  }
  if (isRecord(value)) {
    const stored = value;
    if (
      stored.version === 1 &&
      ((Object.keys(stored).length === LEGACY_TIMER_KEYS.length &&
        LEGACY_TIMER_KEYS.every((key) => Object.hasOwn(stored, key))) ||
        (Object.keys(stored).length === PREVIOUS_TIMER_KEYS.length &&
          PREVIOUS_TIMER_KEYS.every((key) => Object.hasOwn(stored, key))))
    ) {
      value = {
        ...stored,
        startedAt:
          typeof stored.endsAt === "number" && typeof stored.totalSec === "number"
            ? stored.endsAt - stored.totalSec * 1000
            : 0,
        sourceSessionExerciseId:
          typeof stored.sourceSessionExerciseId === "string"
            ? stored.sourceSessionExerciseId
            : null,
        sourceOccurrenceId:
          typeof stored.sourceOccurrenceId === "string"
            ? stored.sourceOccurrenceId
            : null,
        sourceClientKey: null,
        sourceCompletedSetId:
          typeof stored.sourceCompletedSetId === "string"
            ? stored.sourceCompletedSetId
            : null,
      };
    }
  }
  if (!isDurableRestTimer(value)) return { status: "invalid", timer: null };
  if (value.ownerId !== identity.ownerId || value.sessionId !== identity.sessionId) {
    return { status: "foreign", timer: null };
  }
  return { status: "restored", timer: value };
}

export function resolveRestTimerSourceOccurrence<
  T extends {
    id: string;
    sessionExerciseId: string | null;
    completedSetId: string | null;
  },
>(timer: DurableRestTimer, occurrences: readonly T[]): T | null {
  if (
    timer.sourceOccurrenceId == null ||
    timer.sourceSessionExerciseId == null
  ) {
    return null;
  }
  return occurrences.find((occurrence) =>
    occurrence.id === timer.sourceOccurrenceId &&
    occurrence.sessionExerciseId === timer.sourceSessionExerciseId &&
    (timer.sourceCompletedSetId == null ||
      occurrence.completedSetId === timer.sourceCompletedSetId)
  ) ?? null;
}

/**
 * Adds the server set identity to the exact optimistic timer without changing
 * its start or deadline. A later timer is never replaced by an older save.
 */
export function acknowledgeRestTimerSource(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  input: {
    clientKey: string;
    sessionExerciseId: string;
    occurrenceId: string;
    completedSetId: string;
  },
) {
  return withRestTimerLock(() => {
    let current: RestTimerRestoreResult;
    try {
      current = parseStoredRestTimer(
        storage.getItem(REST_TIMER_STORAGE_KEY),
        identity,
      );
    } catch {
      return { status: "storage_error", timer: null } as const;
    }
    if (current.status !== "restored") {
      return { status: current.status, timer: null } as const;
    }
    if (
      current.timer.sourceClientKey !== input.clientKey ||
      current.timer.sourceSessionExerciseId !== input.sessionExerciseId ||
      current.timer.sourceOccurrenceId !== input.occurrenceId
    ) {
      return { status: "unrelated", timer: current.timer } as const;
    }
    if (current.timer.sourceCompletedSetId === input.completedSetId) {
      return { status: "unchanged", timer: current.timer } as const;
    }
    if (current.timer.sourceCompletedSetId != null) {
      return { status: "stale", timer: null } as const;
    }
    const next: DurableRestTimer = {
      ...current.timer,
      revision: current.timer.revision + 1,
      sourceCompletedSetId: input.completedSetId,
    };
    return writeRestTimerCasUnlocked(storage, identity, current.timer, next);
  });
}

/**
 * Claims and attempts the single finish cue when a deadline expired while the
 * document was suspended. Missed countdown ticks are intentionally ignored.
 */
export function deliverMissedRestCompletionCue(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  expectedGenerationId: string,
  requestCue: () => RestCueOutcome,
): Promise<RestTimerForegroundCompletionResult> {
  return withRestTimerLock(() => {
    let current: RestTimerRestoreResult;
    try {
      current = parseStoredRestTimer(
        storage.getItem(REST_TIMER_STORAGE_KEY),
        identity,
      );
    } catch {
      return { status: "storage_error", timer: null, cueOwned: false } as const;
    }
    if (current.status !== "restored") {
      return { status: current.status, timer: null, cueOwned: false } as const;
    }
    const timer = current.timer;
    if (timer.generationId !== expectedGenerationId) {
      return { status: "stale", timer: null, cueOwned: false } as const;
    }
    if (
      timer.phase !== "ready" ||
      timer.completionContext !== "while_away" ||
      timer.completionCueOutcome?.completion !== "missed_while_away"
    ) {
      return { status: "unchanged", timer, cueOwned: false } as const;
    }

    const claimed: DurableRestTimer = {
      ...timer,
      revision: timer.revision + 1,
      completionCueOutcome: {
        sound: "not_requested",
        vibration: "not_requested",
        completion: "requested",
      },
    };
    const claim = writeRestTimerCasUnlocked(storage, identity, timer, claimed);
    if (claim.status !== "updated") {
      return { ...claim, cueOwned: false } as RestTimerForegroundCompletionResult;
    }

    let outcome = claimed.completionCueOutcome!;
    try {
      const requested = requestCue();
      if (isCueOutcome(requested)) {
        outcome = { ...requested, completion: "requested" };
      }
    } catch {
      // The durable claim prevents duplicate resume alarms after a failure.
    }
    const completed: DurableRestTimer = {
      ...claimed,
      revision: claimed.revision + 1,
      completionCueOutcome: outcome,
    };
    const written = writeRestTimerCasUnlocked(
      storage,
      identity,
      claimed,
      completed,
    );
    return written.status === "updated"
      ? { status: "completed", timer: written.timer, cueOwned: true } as const
      : { ...written, cueOwned: false } as RestTimerForegroundCompletionResult;
  });
}

export function readRestTimer(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  now = Date.now(),
) {
  try {
    return restoreRestTimer(storage.getItem(REST_TIMER_STORAGE_KEY), identity, now);
  } catch {
    return { status: "invalid", timer: null } as const;
  }
}

function writeRestTimerUnlocked(storage: RestTimerStorage, timer: DurableRestTimer) {
  if (!isDurableRestTimer(timer)) return false;
  try {
    storage.setItem(REST_TIMER_STORAGE_KEY, JSON.stringify(timer));
    publishRestTimerChange();
    return true;
  } catch {
    return false;
  }
}

function clearRestTimerUnlocked(storage: RestTimerStorage) {
  try {
    storage.removeItem(REST_TIMER_STORAGE_KEY);
    publishRestTimerChange();
    return true;
  } catch {
    return false;
  }
}

export async function withRestTimerLock<T>(task: () => T | Promise<T>) {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      REST_TIMER_LOCK_NAME,
      { mode: "exclusive" },
      task,
    );
  }
  return task();
}

/** Replaces the current generation under the same lock as every mutation. */
export function writeRestTimer(
  storage: RestTimerStorage,
  timer: DurableRestTimer,
) {
  return withRestTimerLock(() => writeRestTimerUnlocked(storage, timer));
}

/** Prefer identity-scoped clearing; this remains for explicit global cleanup. */
export function clearRestTimer(storage: RestTimerStorage) {
  return withRestTimerLock(() => clearRestTimerUnlocked(storage));
}

/**
 * Clears only the record owned by the exact workout. A different workout's
 * single-device timer is preserved.
 */
function clearRestTimerForIdentityUnlocked(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  expectedGenerationId?: string,
) {
  try {
    const raw = storage.getItem(REST_TIMER_STORAGE_KEY);
    const result = parseStoredRestTimer(raw, identity);
    if (result.status !== "restored") return result.status;
    if (
      expectedGenerationId != null &&
      result.timer.generationId !== expectedGenerationId
    ) {
      return "stale" as const;
    }
    if (storage.getItem(REST_TIMER_STORAGE_KEY) !== raw) {
      return "stale" as const;
    }
    storage.removeItem(REST_TIMER_STORAGE_KEY);
    publishRestTimerChange();
    return "cleared" as const;
  } catch {
    return "storage_error" as const;
  }
}

export function clearRestTimerForIdentity(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  expectedGenerationId?: string,
) {
  return withRestTimerLock(() =>
    clearRestTimerForIdentityUnlocked(storage, identity, expectedGenerationId)
  );
}

/** Clears only the timer created by this exact queued set. */
export function clearRestTimerForSourceClientKey(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  sourceClientKey: string,
) {
  return withRestTimerLock(() => {
    let current: RestTimerRestoreResult;
    try {
      current = parseStoredRestTimer(
        storage.getItem(REST_TIMER_STORAGE_KEY),
        identity,
      );
    } catch {
      return "storage_error" as const;
    }
    if (current.status !== "restored") return current.status;
    if (
      current.timer.sourceClientKey != null &&
      current.timer.sourceClientKey !== sourceClientKey
    ) return "stale" as const;
    return clearRestTimerForIdentityUnlocked(
      storage,
      identity,
      current.timer.generationId,
    );
  });
}

/**
 * Reads and durably stores the normalized ready state produced when a running
 * timer elapsed while the app was away. The raw-value recheck prevents a
 * restore from replacing a newer generation that arrived during the read.
 */
function restoreAndPersistRestTimerUnlocked(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  now = Date.now(),
): RestTimerRestoreResult {
  let raw: string | null;
  try {
    raw = storage.getItem(REST_TIMER_STORAGE_KEY);
  } catch {
    return { status: "invalid", timer: null };
  }
  const result = restoreRestTimer(raw, identity, now);
  const stored = parseStoredRestTimer(raw, identity);
  if (
    result.status !== "restored" ||
    stored.status !== "restored" ||
    raw == null ||
    stored.timer.phase !== "running" ||
    result.timer.phase !== "ready"
  ) {
    return result;
  }
  try {
    if (storage.getItem(REST_TIMER_STORAGE_KEY) !== raw) {
      return readRestTimer(storage, identity, now);
    }
    storage.setItem(REST_TIMER_STORAGE_KEY, JSON.stringify(result.timer));
    publishRestTimerChange();
    return result;
  } catch {
    return result;
  }
}

export function restoreAndPersistRestTimer(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  now = Date.now(),
) {
  return withRestTimerLock(() =>
    restoreAndPersistRestTimerUnlocked(storage, identity, now)
  );
}

/**
 * Updates only the latest exact generation/revision. Stale component or tab
 * snapshots therefore cannot erase a replacement timer or newer receipts.
 */
function writeRestTimerCasUnlocked(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  expected: Pick<DurableRestTimer, "generationId" | "revision">,
  next: DurableRestTimer,
): RestTimerCasResult {
  try {
    const raw = storage.getItem(REST_TIMER_STORAGE_KEY);
    const current = parseStoredRestTimer(raw, identity);
    if (current.status !== "restored") {
      return { status: current.status, timer: null };
    }
    if (
      current.timer.generationId !== expected.generationId ||
      current.timer.revision !== expected.revision ||
      next.generationId !== expected.generationId ||
      next.ownerId !== identity.ownerId ||
      next.sessionId !== identity.sessionId ||
      next.revision !== expected.revision + 1 ||
      !isDurableRestTimer(next)
    ) {
      return { status: "stale", timer: null };
    }
    if (storage.getItem(REST_TIMER_STORAGE_KEY) !== raw) {
      return { status: "stale", timer: null };
    }
    storage.setItem(REST_TIMER_STORAGE_KEY, JSON.stringify(next));
    publishRestTimerChange();
    return { status: "updated", timer: next };
  } catch {
    return { status: "storage_error", timer: null };
  }
}

export function writeRestTimerCas(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  expected: Pick<DurableRestTimer, "generationId" | "revision">,
  next: DurableRestTimer,
) {
  return withRestTimerLock(() =>
    writeRestTimerCasUnlocked(storage, identity, expected, next)
  );
}

/** Claims cue receipts before browser sound/vibration APIs are invoked. */
function claimRestCueMilestonesUnlocked(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  expectedGenerationId: string,
  milestones: RestCueMilestone[],
): RestCueClaimResult {
  let result: RestTimerRestoreResult;
  try {
    result = parseStoredRestTimer(
      storage.getItem(REST_TIMER_STORAGE_KEY),
      identity,
    );
  } catch {
    return { status: "storage_error", timer: null, claimedMilestones: [] };
  }
  if (result.status !== "restored") {
    return { status: result.status, timer: null, claimedMilestones: [] };
  }
  if (result.timer.generationId !== expectedGenerationId) {
    return { status: "stale", timer: null, claimedMilestones: [] };
  }
  const attempted = new Set(result.timer.attemptedMilestones);
  const claimedMilestones = MILESTONES.filter(
    (milestone) => milestones.includes(milestone) && !attempted.has(milestone),
  );
  if (claimedMilestones.length === 0) {
    return { status: "unchanged", timer: result.timer, claimedMilestones };
  }
  const next = markRestCueMilestones(result.timer, claimedMilestones);
  const written = writeRestTimerCasUnlocked(storage, identity, result.timer, next);
  return { ...written, claimedMilestones: written.status === "updated" ? claimedMilestones : [] };
}

export function claimRestCueMilestones(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  expectedGenerationId: string,
  milestones: RestCueMilestone[],
) {
  return withRestTimerLock(() =>
    claimRestCueMilestonesUnlocked(
      storage,
      identity,
      expectedGenerationId,
      milestones,
    )
  );
}

/**
 * Owns the zero crossing as one locked transaction. The completion receipt is
 * written before the synchronous browser cue request, then the truthful ready
 * outcome is written before releasing the lock. Other tabs can observe the
 * receipt but cannot normalize or request the same cue inside this window.
 */
function completeForegroundCandidateUnlocked(
  storage: RestTimerStorage,
  raw: string | null,
  candidate: DurableRestTimer,
  fallbackOutcome: RestCueOutcome,
  requestCue: () => RestCueOutcome,
): RestTimerForegroundCompletionResult {
    const claimed = markRestCueMilestones(candidate, ["complete"]);
    const provisional = completeRestTimer(
      claimed,
      candidate.endsAt,
      "foreground",
      fallbackOutcome,
    );
    try {
      if (storage.getItem(REST_TIMER_STORAGE_KEY) !== raw) {
        return { status: "stale", timer: null, cueOwned: false } as const;
      }
      // Persist ready plus the receipt before requesting a device cue. This is
      // safe to restore even if the browser closes during the cue request.
      storage.setItem(REST_TIMER_STORAGE_KEY, JSON.stringify(provisional));
    } catch {
      return { status: "storage_error", timer: null, cueOwned: false } as const;
    }

    let outcome = fallbackOutcome;
    try {
      const requested = requestCue();
      if (isCueOutcome(requested)) outcome = requested;
    } catch {
      // The supplied fallback truth is persisted when the browser request fails.
    }
    const completed = outcome === fallbackOutcome
      ? provisional
      : {
          ...provisional,
          revision: provisional.revision + 1,
          completionCueOutcome: outcome,
        };
    try {
      storage.setItem(REST_TIMER_STORAGE_KEY, JSON.stringify(completed));
      publishRestTimerChange();
      return { status: "completed", timer: completed, cueOwned: true } as const;
    } catch {
      // The durable claim remains, preventing a duplicate cue after a failure.
      return { status: "storage_error", timer: null, cueOwned: false } as const;
    }
}

export function completeForegroundRestTimer(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  expectedGenerationId: string,
  now: number,
  fallbackOutcome: RestCueOutcome,
  requestCue: () => RestCueOutcome,
): Promise<RestTimerForegroundCompletionResult> {
  return withRestTimerLock(() => {
    if (
      !Number.isSafeInteger(now) ||
      now <= 0 ||
      !isCueOutcome(fallbackOutcome)
    ) {
      return { status: "invalid", timer: null, cueOwned: false } as const;
    }
    let raw: string | null;
    let current: RestTimerRestoreResult;
    try {
      raw = storage.getItem(REST_TIMER_STORAGE_KEY);
      current = parseStoredRestTimer(raw, identity);
    } catch {
      return { status: "storage_error", timer: null, cueOwned: false } as const;
    }
    if (current.status !== "restored") {
      return { status: current.status, timer: null, cueOwned: false } as const;
    }
    if (current.timer.generationId !== expectedGenerationId) {
      return { status: "stale", timer: null, cueOwned: false } as const;
    }
    if (
      current.timer.phase !== "running" ||
      now < current.timer.endsAt ||
      current.timer.attemptedMilestones.includes("complete")
    ) {
      return {
        status: "unchanged",
        timer: current.timer,
        cueOwned: false,
      } as const;
    }
    return completeForegroundCandidateUnlocked(
      storage,
      raw,
      current.timer,
      fallbackOutcome,
      requestCue,
    );
  });
}

/**
 * Atomically adjusts the latest timer. A reduction through zero never stores
 * an expired running phase: it enters the same receipt-first foreground-ready
 * transaction used by natural completion.
 */
export function adjustStoredRestTimer(
  storage: RestTimerStorage,
  identity: RestTimerIdentity,
  expectedGenerationId: string,
  deltaSeconds: number,
  now: number,
  fallbackOutcome: RestCueOutcome,
  requestCompletionCue: () => RestCueOutcome,
): Promise<RestTimerStoredAdjustmentResult> {
  return withRestTimerLock(() => {
    let raw: string | null;
    let current: RestTimerRestoreResult;
    try {
      raw = storage.getItem(REST_TIMER_STORAGE_KEY);
      current = parseStoredRestTimer(raw, identity);
    } catch {
      return { status: "storage_error", timer: null, cueOwned: false } as const;
    }
    if (current.status !== "restored") {
      return { status: current.status, timer: null, cueOwned: false } as const;
    }
    if (current.timer.generationId !== expectedGenerationId) {
      return { status: "stale", timer: null, cueOwned: false } as const;
    }
    const adjusted = adjustDurableRestTimer(current.timer, deltaSeconds, now);
    if (adjusted === current.timer) {
      return {
        status: "unchanged",
        timer: current.timer,
        cueOwned: false,
      } as const;
    }
    if (adjusted.endsAt > now) {
      const result = writeRestTimerCasUnlocked(
        storage,
        identity,
        current.timer,
        adjusted,
      );
      return result.status === "updated"
        ? { ...result, cueOwned: false } as const
        : { ...result, cueOwned: false } as const;
    }
    if (!isCueOutcome(fallbackOutcome)) {
      return { status: "invalid", timer: null, cueOwned: false } as const;
    }
    return completeForegroundCandidateUnlocked(
      storage,
      raw,
      adjusted,
      fallbackOutcome,
      requestCompletionCue,
    );
  });
}

export function subscribeToRestTimer(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === REST_TIMER_STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(REST_TIMER_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(REST_TIMER_CHANGE_EVENT, onStoreChange);
  };
}

export function publishRestTimerChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(REST_TIMER_CHANGE_EVENT));
  }
}

export function completeRestTimer(
  timer: DurableRestTimer,
  readyAt: number,
  completionContext: RestCompletionContext,
  completionCueOutcome: RestCueOutcome,
): DurableRestTimer {
  if (
    timer.phase !== "running" ||
    !Number.isSafeInteger(readyAt) ||
    readyAt <= 0 ||
    !isCueOutcome(completionCueOutcome) ||
    timer.revision >= Number.MAX_SAFE_INTEGER
  ) return timer;
  const attemptedMilestones = timer.attemptedMilestones.includes("complete")
    ? timer.attemptedMilestones
    : MILESTONES.filter(
        (milestone) =>
          milestone === "complete" || timer.attemptedMilestones.includes(milestone),
      );
  return {
    ...timer,
    revision: timer.revision + 1,
    phase: "ready",
    readyAt,
    completionContext,
    completionCueOutcome,
    attemptedMilestones,
  };
}

export function skipRestTimer(timer: DurableRestTimer, now: number): DurableRestTimer {
  if (
    timer.phase !== "running" ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    timer.revision >= Number.MAX_SAFE_INTEGER
  ) return timer;
  return {
    ...timer,
    revision: timer.revision + 1,
    phase: "skipped",
    readyAt: now,
    completionContext: null,
  };
}

export function adjustDurableRestTimer(
  timer: DurableRestTimer,
  deltaSeconds: number,
  now: number,
): DurableRestTimer {
  if (
    timer.phase !== "running" ||
    !Number.isInteger(deltaSeconds) ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    timer.revision >= Number.MAX_SAFE_INTEGER
  ) {
    return timer;
  }
  const adjustedEndsAt = Math.min(
    now + 1800 * 1000,
    timer.endsAt + deltaSeconds * 1000,
  );
  const endsAt = Math.max(now, adjustedEndsAt);
  return endsAt === timer.endsAt
    ? timer
    : { ...timer, revision: timer.revision + 1, endsAt };
}

export function continueAfterRest(
  timer: DurableRestTimer,
  now: number,
): DurableRestTimer {
  if (
    (timer.phase !== "ready" && timer.phase !== "skipped") ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    timer.revision >= Number.MAX_SAFE_INTEGER
  ) return timer;
  return {
    ...timer,
    revision: timer.revision + 1,
    phase: "continued",
    readyAt: timer.readyAt ?? now,
  };
}

export function markRestCueMilestones(
  timer: DurableRestTimer,
  milestones: RestCueMilestone[],
): DurableRestTimer {
  if (timer.revision >= Number.MAX_SAFE_INTEGER) return timer;
  const attempted = new Set(timer.attemptedMilestones);
  for (const milestone of milestones) attempted.add(milestone);
  const attemptedMilestones = MILESTONES.filter((milestone) => attempted.has(milestone));
  if (
    attemptedMilestones.length === timer.attemptedMilestones.length &&
    attemptedMilestones.every(
      (milestone, index) => milestone === timer.attemptedMilestones[index],
    )
  ) {
    return timer;
  }
  return {
    ...timer,
    revision: timer.revision + 1,
    attemptedMilestones,
  };
}
