import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeRestTimerSource,
  clearRestTimer,
  clearRestTimerForIdentity,
  clearRestTimerForSupersedingSourceClientKey,
  clearRestTimerForExactSourceClientKey,
  claimRestCueMilestones,
  adjustStoredRestTimer,
  adjustDurableRestTimer,
  completeRestTimer,
  completeForegroundRestTimer,
  continueAfterRest,
  createRestTimer,
  deliverMissedRestCompletionCue,
  isDurableRestTimer,
  markRestCueMilestones,
  readRestTimer,
  REST_TIMER_LOCK_NAME,
  remainingRestSeconds,
  restoreRestTimer,
  restoreAndPersistRestTimer,
  resolveRestTimerSourceOccurrence,
  skipRestTimer,
  writeRestTimer,
  writeRestTimerCas,
  withRestTimerLock,
  type DurableRestTimer,
  type RestTimerStorage,
} from "@/lib/rest-timer";

const ownerId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000002";
const generationId = "30000000-0000-4000-8000-000000000003";
const sessionExerciseId = "40000000-0000-4000-8000-000000000004";
const occurrenceId = "50000000-0000-4000-8000-000000000005";
const completedSetId = "60000000-0000-4000-8000-000000000006";
const clientKey = "70000000-0000-4000-8000-000000000007";

class MemoryStorage implements RestTimerStorage {
  value: string | null = null;
  writes: string[] = [];
  getItem() { return this.value; }
  setItem(_key: string, value: string) {
    this.value = value;
    this.writes.push(value);
  }
  removeItem() { this.value = null; }
}

describe("durable rest timer", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("preserves an explicitly added rest against an older set acknowledgement", async () => {
    const storage = new MemoryStorage();
    const extra = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 90 })!;
    await writeRestTimer(storage, extra);
    expect(await clearRestTimerForSupersedingSourceClientKey(storage,
      { ownerId, sessionId }, clientKey, [generationId])).toBe("stale");
    expect(readRestTimer(storage, { ownerId, sessionId }, 5_000)).toMatchObject({
      timer: { generationId, startedAt: 1_000, endsAt: 91_000, sourceCompletedSetId: null },
    });
    expect(await clearRestTimerForSupersedingSourceClientKey(storage,
      { ownerId, sessionId }, occurrenceId, [])).toBe("cleared");
  });

  it("creates a strict absolute timer and derives remaining time", () => {
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 90 });
    expect(timer).toMatchObject({
      generationId,
      revision: 0,
      phase: "running",
      startedAt: 1_000,
      endsAt: 91_000,
      totalSec: 90,
    });
    expect(remainingRestSeconds(timer!, 31_001)).toBe(60);
    expect(createRestTimer({ ownerId, sessionId, now: 1_000, seconds: 0 })).toBeNull();
    expect(createRestTimer({ ownerId, sessionId, now: 1_000, seconds: 1801 })).toBeNull();
    expect(createRestTimer({ ownerId, sessionId, now: Number.MAX_SAFE_INTEGER, seconds: 1 })).toBeNull();
  });

  it("persists the acknowledged result identity and does not follow next-set advancement", () => {
    const timer = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 90,
      sourceSessionExerciseId: sessionExerciseId,
      sourceOccurrenceId: occurrenceId,
      sourceClientKey: clientKey,
      sourceCompletedSetId: completedSetId,
    })!;
    expect(timer).toMatchObject({
      sourceSessionExerciseId: sessionExerciseId,
      sourceOccurrenceId: occurrenceId,
      sourceClientKey: clientKey,
      sourceCompletedSetId: completedSetId,
    });
    const completed = {
      id: occurrenceId,
      sessionExerciseId,
      completedSetId,
    };
    const nextPending = {
      id: "50000000-0000-4000-8000-000000000007",
      sessionExerciseId,
      completedSetId: null,
    };
    expect(resolveRestTimerSourceOccurrence(timer, [nextPending, completed])).toBe(completed);
    expect(resolveRestTimerSourceOccurrence(timer, [nextPending])).toBeNull();
    expect(restoreRestTimer(JSON.stringify(timer), { ownerId, sessionId }, 2_000)).toMatchObject({
      status: "restored",
      timer: { sourceOccurrenceId: occurrenceId, sourceCompletedSetId: completedSetId },
    });
  });

  it("upgrades a legacy source-less timer without inventing a rest attachment", () => {
    const current = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    const legacy = { ...current } as Record<string, unknown>;
    delete legacy.sourceSessionExerciseId;
    delete legacy.sourceOccurrenceId;
    delete legacy.sourceClientKey;
    delete legacy.sourceCompletedSetId;
    delete legacy.startedAt;
    expect(restoreRestTimer(JSON.stringify(legacy), { ownerId, sessionId }, 2_000)).toMatchObject({
      status: "restored",
      timer: {
        sourceSessionExerciseId: null,
        sourceOccurrenceId: null,
        sourceClientKey: null,
        sourceCompletedSetId: null,
      },
    });
  });

  it("starts from the device command and adds acknowledgement without resetting the deadline", async () => {
    const storage = new MemoryStorage();
    const timer = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 90,
      sourceSessionExerciseId: sessionExerciseId,
      sourceOccurrenceId: occurrenceId,
      sourceClientKey: clientKey,
    })!;
    await writeRestTimer(storage, timer);
    const result = await acknowledgeRestTimerSource(
      storage,
      { ownerId, sessionId },
      { clientKey, sessionExerciseId, occurrenceId, completedSetId },
    );
    expect(result).toMatchObject({
      status: "updated",
      timer: {
        startedAt: 1_000,
        endsAt: 91_000,
        sourceClientKey: clientKey,
        sourceCompletedSetId: completedSetId,
      },
    });
  });

  it("keeps a dismissed timer as a tombstone when its delayed save acknowledges", async () => {
    const storage = new MemoryStorage();
    const timer = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 30,
      sourceSessionExerciseId: sessionExerciseId,
      sourceOccurrenceId: occurrenceId,
      sourceClientKey: clientKey,
    })!;
    const ready = completeRestTimer(timer, 31_000, "foreground", {
      sound: "requested",
      vibration: "not_requested",
      completion: "requested",
    });
    const dismissed = continueAfterRest(ready, 32_000);
    await writeRestTimer(storage, dismissed);

    const result = await acknowledgeRestTimerSource(
      storage,
      { ownerId, sessionId },
      { clientKey, sessionExerciseId, occurrenceId, completedSetId },
    );

    expect(result).toMatchObject({
      status: "updated",
      timer: {
        phase: "continued",
        startedAt: 1_000,
        endsAt: 31_000,
        sourceClientKey: clientKey,
        sourceCompletedSetId: completedSetId,
      },
    });
  });

  it("attempts only one final cue when an elapsed timer returns from suspension", async () => {
    const storage = new MemoryStorage();
    const timer = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 30,
    })!;
    await writeRestTimer(storage, timer);
    await restoreAndPersistRestTimer(storage, { ownerId, sessionId }, 40_000);
    const cue = vi.fn(() => ({
      sound: "requested" as const,
      vibration: "unavailable" as const,
      completion: "requested" as const,
    }));
    const first = await deliverMissedRestCompletionCue(
      storage,
      { ownerId, sessionId },
      generationId,
      cue,
    );
    const second = await deliverMissedRestCompletionCue(
      storage,
      { ownerId, sessionId },
      generationId,
      cue,
    );
    expect(first).toMatchObject({ status: "completed", cueOwned: true });
    expect(second).toMatchObject({ status: "unchanged", cueOwned: false });
    expect(cue).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, foreign, and internally inconsistent records", () => {
    expect(restoreRestTimer("not-json", { ownerId, sessionId }, 1_000).status).toBe("invalid");
    expect(restoreRestTimer(JSON.stringify({ version: 1 }), { ownerId, sessionId }, 1_000).status).toBe("invalid");
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    expect(restoreRestTimer(JSON.stringify(timer), { ownerId, sessionId: ownerId }, 1_000).status).toBe("foreign");
    expect(isDurableRestTimer({ ...timer, attemptedMilestones: ["15", "15"] })).toBe(false);
    expect(isDurableRestTimer({ ...timer, readyAt: 2_000 })).toBe(false);
    expect(isDurableRestTimer({ ...timer, extra: true })).toBe(false);
    expect(isDurableRestTimer({ ...timer, revision: -1 })).toBe(false);
    expect(isDurableRestTimer({ ...timer, generationId: "not-a-uuid" })).toBe(false);
  });

  it("restores a running timer and turns an elapsed reload into truthful ready state", () => {
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    expect(restoreRestTimer(JSON.stringify(timer), { ownerId, sessionId }, 10_000)).toEqual({ status: "restored", timer });
    expect(restoreRestTimer(JSON.stringify(timer), { ownerId, sessionId }, 40_000)).toMatchObject({
      status: "restored",
      timer: {
        phase: "ready",
        revision: 1,
        readyAt: 31_000,
        completionContext: "while_away",
        completionCueOutcome: {
          sound: "not_requested",
          vibration: "not_requested",
          completion: "missed_while_away",
        },
        attemptedMilestones: ["complete"],
      },
    });
  });

  it("models foreground completion, skip, and explicit continue distinctly", () => {
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    const ready = completeRestTimer(timer, 31_000, "foreground", {
      sound: "requested",
      vibration: "unavailable",
      completion: "requested",
    });
    expect(ready).toMatchObject({
      phase: "ready",
      completionContext: "foreground",
      completionCueOutcome: {
        sound: "requested",
        vibration: "unavailable",
        completion: "requested",
      },
    });
    expect(continueAfterRest(ready, 32_000).phase).toBe("continued");
    const skipped = skipRestTimer(timer, 5_000);
    expect(skipped).toMatchObject({ phase: "skipped", readyAt: 5_000, completionContext: null });
    expect(continueAfterRest(skipped, 6_000).phase).toBe("continued");
    expect(completeRestTimer(timer, Number.NaN, "foreground", {
      sound: "requested",
      vibration: "not_requested",
      completion: "requested",
    })).toBe(timer);
    expect(skipRestTimer(timer, -1)).toBe(timer);
  });

  it("adjusts only a running timer, caps extension, and completes when reduced through zero", () => {
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    expect(adjustDurableRestTimer(timer, 15, 2_000).endsAt).toBe(46_000);
    expect(adjustDurableRestTimer(timer, -60, 2_000)).toMatchObject({
      phase: "running",
      endsAt: 2_000,
    });
    expect(adjustDurableRestTimer(timer, 10_000, 2_000).endsAt).toBe(1_802_000);
  });

  it("marks milestones once in canonical order", () => {
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    const marked = markRestCueMilestones(timer, ["10", "15", "10"]);
    expect(marked.attemptedMilestones).toEqual(["15", "10"]);
    expect(markRestCueMilestones(marked, ["complete"]).attemptedMilestones).toEqual(["15", "10", "complete"]);
  });

  it("reads, writes, and clears without exposing storage failures", async () => {
    const storage = new MemoryStorage();
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    await expect(writeRestTimer(storage, timer)).resolves.toBe(true);
    expect(readRestTimer(storage, { ownerId, sessionId }, 2_000)).toEqual({ status: "restored", timer });
    await expect(clearRestTimer(storage)).resolves.toBe(true);
    expect(readRestTimer(storage, { ownerId, sessionId }, 2_000).status).toBe("empty");
  });

  it("persists an elapsed restore once with a durable completion receipt", async () => {
    const storage = new MemoryStorage();
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    await writeRestTimer(storage, timer);
    const restored = await restoreAndPersistRestTimer(storage, { ownerId, sessionId }, 40_000);
    expect(restored).toMatchObject({
      status: "restored",
      timer: {
        phase: "ready",
        revision: 1,
        attemptedMilestones: ["complete"],
        completionContext: "while_away",
      },
    });
    expect(readRestTimer(storage, { ownerId, sessionId }, 50_000)).toEqual(restored);
  });

  it("rejects stale generation and revision writes without erasing newer truth", async () => {
    const storage = new MemoryStorage();
    const first = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    await writeRestTimer(storage, first);
    const receipt = markRestCueMilestones(first, ["15"]);
    expect((await writeRestTimerCas(storage, { ownerId, sessionId }, first, receipt)).status).toBe("updated");
    const staleAdjustment = adjustDurableRestTimer(first, 15, 2_000);
    expect((await writeRestTimerCas(storage, { ownerId, sessionId }, first, staleAdjustment)).status).toBe("stale");
    expect(readRestTimer(storage, { ownerId, sessionId }, 2_000)).toMatchObject({
      status: "restored",
      timer: { revision: 1, attemptedMilestones: ["15"] },
    });

    const replacement = createRestTimer({
      ownerId,
      sessionId,
      generationId: "40000000-0000-4000-8000-000000000004",
      now: 3_000,
      seconds: 60,
    })!;
    await writeRestTimer(storage, replacement);
    expect((await writeRestTimerCas(storage, { ownerId, sessionId }, receipt, completeRestTimer(
      receipt,
      31_000,
      "foreground",
      { sound: "requested", vibration: "not_requested", completion: "requested" },
    ))).status).toBe("stale");
    expect(readRestTimer(storage, { ownerId, sessionId }, 4_000)).toMatchObject({
      status: "restored",
      timer: { generationId: replacement.generationId, revision: 0 },
    });
  });

  it("claims milestones durably before cues and suppresses a stale second claim", async () => {
    const storage = new MemoryStorage();
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    await writeRestTimer(storage, timer);
    const first = await claimRestCueMilestones(
      storage,
      { ownerId, sessionId },
      generationId,
      ["15", "10"],
    );
    expect(first).toMatchObject({
      status: "updated",
      claimedMilestones: ["15", "10"],
      timer: { revision: 1, attemptedMilestones: ["15", "10"] },
    });
    expect(await claimRestCueMilestones(
      storage,
      { ownerId, sessionId },
      generationId,
      ["15", "10"],
    )).toMatchObject({ status: "unchanged", claimedMilestones: [] });
    expect(await claimRestCueMilestones(
      storage,
      { ownerId, sessionId },
      "40000000-0000-4000-8000-000000000004",
      ["complete"],
    )).toMatchObject({ status: "stale", claimedMilestones: [] });
  });

  it("clears only the matching workout and optional timer generation", async () => {
    const storage = new MemoryStorage();
    const timer = createRestTimer({ ownerId, sessionId, generationId, now: 1_000, seconds: 30 })!;
    await writeRestTimer(storage, timer);
    expect(await clearRestTimerForIdentity(storage, { ownerId, sessionId: ownerId })).toBe("foreign");
    expect(storage.value).not.toBeNull();
    expect(await clearRestTimerForIdentity(
      storage,
      { ownerId, sessionId },
      "40000000-0000-4000-8000-000000000004",
    )).toBe("stale");
    expect(storage.value).not.toBeNull();
    expect(await clearRestTimerForIdentity(storage, { ownerId, sessionId }, generationId)).toBe("cleared");
    expect(storage.value).toBeNull();
  });

  it("clears only the exact client-bound timer source", async () => {
    const storage = new MemoryStorage();
    const sourceLess = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 30,
    })!;
    await writeRestTimer(storage, sourceLess);
    await expect(clearRestTimerForExactSourceClientKey(
      storage,
      { ownerId, sessionId },
      clientKey,
    )).resolves.toBe("stale");
    expect(storage.value).not.toBeNull();

    const matching = createRestTimer({
      ownerId,
      sessionId,
      generationId: "80000000-0000-4000-8000-000000000008",
      now: 2_000,
      seconds: 30,
      sourceSessionExerciseId: sessionExerciseId,
      sourceOccurrenceId: occurrenceId,
      sourceClientKey: clientKey,
    })!;
    await writeRestTimer(storage, matching);
    await expect(clearRestTimerForExactSourceClientKey(
      storage,
      { ownerId, sessionId },
      clientKey,
    )).resolves.toBe("cleared");
    expect(storage.value).toBeNull();
  });

  it("serializes every timer mutation through the shared browser lock", async () => {
    const requestedNames: string[] = [];
    let tail = Promise.resolve();
    const locks = {
      request: <T>(
        name: string,
        _options: { mode: "exclusive" },
        task: () => T | Promise<T>,
      ) => {
        requestedNames.push(name);
        const run = tail.then(task);
        tail = run.then(() => undefined, () => undefined);
        return run;
      },
    };
    vi.stubGlobal("navigator", { locks });

    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = false;
    let secondEntered = false;
    const first = withRestTimerLock(async () => {
      firstEntered = true;
      await firstMayFinish;
    });
    await expect.poll(() => firstEntered).toBe(true);
    const second = withRestTimerLock(() => {
      secondEntered = true;
    });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    expect(requestedNames).toEqual([REST_TIMER_LOCK_NAME, REST_TIMER_LOCK_NAME]);
  });

  it("uses the synchronous CAS fallback only when Web Locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(withRestTimerLock(() => "fallback")).resolves.toBe("fallback");
  });

  it("routes replacement, restore, claim, CAS, and scoped clear through the lock", async () => {
    const requestedNames: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: <T>(
          name: string,
          _options: { mode: "exclusive" },
          task: () => T | Promise<T>,
        ) => {
          requestedNames.push(name);
          return Promise.resolve().then(task);
        },
      },
    });
    const storage = new MemoryStorage();
    const timer = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 30,
    })!;
    await writeRestTimer(storage, timer);
    await restoreAndPersistRestTimer(storage, { ownerId, sessionId }, 2_000);
    const claim = await claimRestCueMilestones(
      storage,
      { ownerId, sessionId },
      generationId,
      ["15"],
    );
    expect(claim.status).toBe("updated");
    const current = claim.timer!;
    await writeRestTimerCas(
      storage,
      { ownerId, sessionId },
      current,
      adjustDurableRestTimer(current, 15, 2_000),
    );
    await clearRestTimerForIdentity(
      storage,
      { ownerId, sessionId },
      generationId,
    );
    expect(requestedNames).toEqual(Array(5).fill(REST_TIMER_LOCK_NAME));
  });

  it("atomically assigns foreground completion cue ownership to only one tab", async () => {
    let tail = Promise.resolve();
    vi.stubGlobal("navigator", {
      locks: {
        request: <T>(
          _name: string,
          _options: { mode: "exclusive" },
          task: () => T | Promise<T>,
        ) => {
          const run = tail.then(task);
          tail = run.then(() => undefined, () => undefined);
          return run;
        },
      },
    });
    const storage = new MemoryStorage();
    const timer = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 1,
    })!;
    await writeRestTimer(storage, timer);
    let cueRequests = 0;
    const fallback = {
      sound: "unavailable",
      vibration: "not_requested",
      completion: "unavailable",
    } as const;
    const request = () => {
      cueRequests += 1;
      return {
        sound: "requested",
        vibration: "not_requested",
        completion: "requested",
      } as const;
    };
    const [first, second] = await Promise.all([
      completeForegroundRestTimer(
        storage,
        { ownerId, sessionId },
        generationId,
        2_000,
        fallback,
        request,
      ),
      completeForegroundRestTimer(
        storage,
        { ownerId, sessionId },
        generationId,
        2_000,
        fallback,
        request,
      ),
    ]);
    expect([first.status, second.status]).toEqual(["completed", "unchanged"]);
    expect(cueRequests).toBe(1);
    expect(readRestTimer(storage, { ownerId, sessionId }, 3_000)).toMatchObject({
      status: "restored",
      timer: {
        phase: "ready",
        revision: 3,
        attemptedMilestones: ["complete"],
        completionContext: "foreground",
        completionCueOutcome: {
          sound: "requested",
          completion: "requested",
        },
      },
    });
  });

  it("persists conservative fallback truth when the owned cue request throws", async () => {
    vi.stubGlobal("navigator", {});
    const storage = new MemoryStorage();
    const timer = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 1,
    })!;
    await writeRestTimer(storage, timer);
    const result = await completeForegroundRestTimer(
      storage,
      { ownerId, sessionId },
      generationId,
      2_000,
      {
        sound: "blocked",
        vibration: "not_requested",
        completion: "blocked",
      },
      () => {
        throw new Error("browser rejected cue");
      },
    );
    expect(result).toMatchObject({
      status: "completed",
      cueOwned: true,
      timer: {
        phase: "ready",
        completionCueOutcome: {
          sound: "blocked",
          completion: "blocked",
        },
      },
    });
  });

  it("adjusts through zero without ever storing an expired running timer", async () => {
    vi.stubGlobal("navigator", {});
    const storage = new MemoryStorage();
    const timer = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 30,
    })!;
    await writeRestTimer(storage, timer);
    const writesBeforeAdjustment = storage.writes.length;
    let cues = 0;
    const result = await adjustStoredRestTimer(
      storage,
      { ownerId, sessionId },
      generationId,
      -60,
      1_000,
      {
        sound: "unavailable",
        vibration: "not_requested",
        completion: "unavailable",
      },
      () => {
        cues += 1;
        return {
          sound: "requested",
          vibration: "not_requested",
          completion: "requested",
        };
      },
    );
    expect(result).toMatchObject({
      status: "completed",
      cueOwned: true,
      timer: {
        phase: "ready",
        revision: 4,
        endsAt: 1_000,
        readyAt: 1_000,
        attemptedMilestones: ["complete"],
      },
    });
    expect(cues).toBe(1);
    const adjustmentWrites = storage.writes.slice(writesBeforeAdjustment)
      .map((raw) => JSON.parse(raw) as DurableRestTimer);
    expect(adjustmentWrites).toHaveLength(2);
    expect(adjustmentWrites.every((stored) => stored.phase === "ready")).toBe(true);
  });

  it("serializes two tabs adjusting through zero to one completion owner", async () => {
    let tail = Promise.resolve();
    vi.stubGlobal("navigator", {
      locks: {
        request: <T>(
          _name: string,
          _options: { mode: "exclusive" },
          task: () => T | Promise<T>,
        ) => {
          const run = tail.then(task);
          tail = run.then(() => undefined, () => undefined);
          return run;
        },
      },
    });
    const storage = new MemoryStorage();
    const timer = createRestTimer({
      ownerId,
      sessionId,
      generationId,
      now: 1_000,
      seconds: 30,
    })!;
    await writeRestTimer(storage, timer);
    let cues = 0;
    const adjust = () => adjustStoredRestTimer(
      storage,
      { ownerId, sessionId },
      generationId,
      -60,
      2_000,
      {
        sound: "unavailable",
        vibration: "not_requested",
        completion: "unavailable",
      },
      () => {
        cues += 1;
        return {
          sound: "requested",
          vibration: "not_requested",
          completion: "requested",
        };
      },
    );
    const [first, second] = await Promise.all([adjust(), adjust()]);
    expect([first.status, second.status]).toEqual(["completed", "unchanged"]);
    expect(cues).toBe(1);
  });
});
