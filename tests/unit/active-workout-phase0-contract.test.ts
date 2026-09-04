import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_SET_ROW_STATES,
  projectActiveSetRows,
} from "@/lib/active-set-row-projection";
import {
  activeSetVersionEvidenceAfterCorrection,
  activeSetVersionEvidenceFromActions,
} from "@/lib/active-set-version-evidence";
import {
  ACTIVE_WORKOUT_EQUIPMENT_STATES,
  ACTIVE_WORKOUT_REST_STATES,
  ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS,
  ACTIVE_WORKOUT_SESSION_STATES,
  REST_COMPLETE_CONFIRMATION_MS,
  projectActiveWorkoutEquipmentPresentation,
  projectActiveWorkoutRestPresentation,
  projectActiveWorkoutSessionState,
} from "@/lib/active-workout-presentation-state";
import {
  EQUIPMENT_STATE_FIXTURES,
  EQUIPMENT_CUE_STATUS_FIXTURES,
  NORTH_STAR_NOW_MS,
  REST_TIMER_PHASE_FIXTURES,
  REST_STATE_FIXTURES,
  SESSION_STATE_FIXTURES,
  SET_ROW_CROSS_AXIS_FIXTURES,
  SET_ROW_MEMBERSHIP_FIXTURES,
  SET_ROW_STATE_FIXTURES,
  SET_ROW_VERSION_FIXTURES,
} from "../fixtures/active-workout-north-star";

describe("Phase 0 active-set row contract", () => {
  it("executes one typed fixture for every exclusive row state", () => {
    expect(Object.keys(SET_ROW_STATE_FIXTURES).sort()).toEqual(
      [...ACTIVE_SET_ROW_STATES].sort(),
    );
    for (const fixture of Object.values(SET_ROW_STATE_FIXTURES)) {
      const projection = projectActiveSetRows(fixture.input);
      expect(projection.rows).toHaveLength(1);
      expect(projection.rows[0].state).toBe(fixture.expectedState);
    }
  });

  it("keeps membership and revision provenance orthogonal to persistence", () => {
    for (const fixture of Object.values(SET_ROW_CROSS_AXIS_FIXTURES)) {
      const row = projectActiveSetRows(fixture.input).rows[0];
      expect(row.state).toBe(fixture.expectedState);
      expect(row.membership).toBe(fixture.expectedMembership);
    }

    const failedExtra = projectActiveSetRows(
      SET_ROW_CROSS_AXIS_FIXTURES.failedExtra.input,
    ).rows[0];
    expect(failedExtra).toMatchObject({
      state: "failed",
      membership: "extra",
      outcome: "pending",
    });

    const restoredExtra = projectActiveSetRows(
      SET_ROW_CROSS_AXIS_FIXTURES.restoredExtra.input,
    ).rows[0];
    expect(restoredExtra).toMatchObject({
      state: "saved",
      membership: "extra",
      version: { state: "version_restored", count: 1 },
    });

    const correctedExtra = projectActiveSetRows(
      SET_ROW_CROSS_AXIS_FIXTURES.correctedExtra.input,
    ).rows[0];
    expect(correctedExtra).toMatchObject({
      state: "saved",
      membership: "extra",
      version: { state: "corrected", count: 2 },
    });

    const failedCorrected = projectActiveSetRows(
      SET_ROW_CROSS_AXIS_FIXTURES.failedCorrected.input,
    ).rows[0];
    expect(failedCorrected).toMatchObject({
      state: "failed",
      membership: "planned",
      version: { state: "corrected", count: 1 },
    });
  });

  it("executes every occurrence membership without changing row lifecycle", () => {
    for (const [membership, fixture] of Object.entries(
      SET_ROW_MEMBERSHIP_FIXTURES,
    )) {
      const row = projectActiveSetRows(fixture.input).rows[0];
      expect(row.state).toBe(fixture.expectedState);
      expect(row.membership).toBe(membership);
    }
  });

  it("executes every supported version provenance explicitly", () => {
    for (const [versionState, fixture] of Object.entries(
      SET_ROW_VERSION_FIXTURES,
    )) {
      const row = projectActiveSetRows(fixture.input).rows[0];
      expect(row.state).toBe(fixture.expectedState);
      expect(row.version?.state ?? null).toBe(versionState);
    }
  });

  it("uses the newest live version action for the headline and counts all changes", () => {
    expect(activeSetVersionEvidenceFromActions([])).toEqual({
      state: "original",
      count: 0,
    });
    expect(activeSetVersionEvidenceFromActions([
      "set.completed_correction",
      "set.version_restore",
      "set.active_correction",
    ])).toEqual({ state: "corrected", count: 3 });
    expect(activeSetVersionEvidenceFromActions([
      "set.version_restore",
      "set.snapshot_restore",
      "unrelated.action",
    ])).toEqual({ state: "version_restored", count: 2 });
    expect(activeSetVersionEvidenceAfterCorrection(
      { state: "snapshot_restored", count: 2 },
      0,
    )).toEqual({ state: "corrected", count: 3 });
  });

  it.each(["bodyweight", "dumbbell"])(
    "withholds an original movement's load and note after a %s substitution",
    (loadType) => {
      const input = SET_ROW_STATE_FIXTURES.current_editable.input;
      const row = projectActiveSetRows({
        ...input,
        exercise: {
          ...input.exercise,
          exerciseId: "40000000-0000-4000-8000-000000000099",
          loadType,
          modificationType: "substituted",
          substitutedForExerciseId: input.exercise.exerciseId,
        },
        occurrences: [{
          ...input.occurrences[0],
          plannedNote: "Original movement tempo cue",
          plannedLoad: 95,
          plannedLoadUnit: "lb",
          plannedLoadPercent: 75,
          plannedLoadText: "Original movement load",
        }],
      }).rows[0];

      expect(row).toMatchObject({
        state: "current_editable",
        prescription: {
          repsMin: 8,
          repsMax: 8,
          load: null,
          loadUnit: null,
          loadPercent: null,
          loadText: null,
          note: null,
        },
      });
    },
  );

  it("preserves the exact device result while it is retained", () => {
    const row = projectActiveSetRows(
      SET_ROW_STATE_FIXTURES.retained_locally.input,
    ).rows[0];
    expect(row).toMatchObject({
      state: "retained_locally",
      result: {
        weight: 95,
        weightUnit: "lb",
        reps: 8,
        rpe: 8,
        rir: 2,
        note: "Exact device result",
      },
    });
  });

  it("uses occurrence identity and sequence rather than display order or name", () => {
    const first = SET_ROW_STATE_FIXTURES.saved.input;
    const firstOccurrence = first.occurrences[0];
    const firstSet = first.exercise.sets[0];
    const secondOccurrence = {
      ...firstOccurrence,
      id: "60000000-0000-4000-8000-000000000002",
      sequenceIdx: 20,
      kindOrdinal: 1,
      completedSetId: "70000000-0000-4000-8000-000000000002",
    };
    const secondSet = {
      ...firstSet,
      id: "70000000-0000-4000-8000-000000000002",
      clientKey: "80000000-0000-4000-8000-000000000002",
      occurrenceId: secondOccurrence.id,
      setNo: 2,
      weight: 100,
    };
    const projection = projectActiveSetRows({
      ...first,
      exercise: { ...first.exercise, name: "Duplicate display name", sets: [secondSet, firstSet] },
      occurrences: [secondOccurrence, firstOccurrence],
    });

    expect(projection.rows.map((row) => row.occurrenceId)).toEqual([
      firstOccurrence.id,
      secondOccurrence.id,
    ]);
    expect(projection.rows.map((row) => row.result?.weight)).toEqual([95, 100]);
    expect(projection.diagnostics).toEqual({
      unlinkedSetIds: [],
      duplicateSetIds: [],
      contradictoryOccurrenceIds: [],
      acknowledgedOutboxClientKeys: [],
    });
  });

  it("does not present unsupported retained evidence as acknowledged", () => {
    const base = SET_ROW_STATE_FIXTURES.current_editable.input;
    const unsupported = {
      ...SET_ROW_STATE_FIXTURES.saved.input.exercise.sets[0],
      id: "unsupported-retained-result",
      clientKey: null,
      saveState: "pending" as const,
      occurrenceId: base.occurrences[0].id,
    };
    const row = projectActiveSetRows({
      ...base,
      exercise: { ...base.exercise, sets: [unsupported] },
    }).rows[0];

    expect(row).toMatchObject({
      state: "unknown_legacy",
      result: { id: "unsupported-retained-result" },
    });
    expect(row.state).not.toBe("saved");
  });

  it("fails closed when runtime save evidence is newer than the typed contract", () => {
    const acknowledged = SET_ROW_STATE_FIXTURES.saved.input;
    const set = acknowledged.exercise.sets[0];
    const projection = projectActiveSetRows({
      ...acknowledged,
      exercise: {
        ...acknowledged.exercise,
        sets: [{ ...set, saveState: "future_state" as never }],
      },
    });

    expect(projection.rows[0]).toMatchObject({
      state: "unknown_legacy",
      result: { id: set.id },
      message: expect.stringContaining("unsupported save evidence"),
    });
    expect(projection.rows[0].state).not.toBe("saved");
  });

  it("fails closed when runtime occurrence evidence is newer than the typed contract", () => {
    const planned = SET_ROW_STATE_FIXTURES.planned.input;
    const projection = projectActiveSetRows({
      ...planned,
      occurrences: [
        { ...planned.occurrences[0], outcome: "future_outcome" as never },
      ],
    });

    expect(projection.rows[0]).toMatchObject({
      state: "unknown_legacy",
      result: null,
      message: expect.stringContaining("unsupported outcome"),
    });
    expect(projection.rows[0].state).not.toBe("planned");
  });

  it("does not present an acknowledged result on a pending occurrence as saved", () => {
    const pending = SET_ROW_STATE_FIXTURES.current_editable.input;
    const acknowledged = SET_ROW_STATE_FIXTURES.saved.input.exercise.sets[0];
    const projection = projectActiveSetRows({
      ...pending,
      exercise: { ...pending.exercise, sets: [acknowledged] },
    });

    expect(projection.rows[0]).toMatchObject({
      state: "unknown_legacy",
      result: { id: acknowledged.id },
      message: expect.stringContaining("unresolved occurrence"),
    });
    expect(projection.diagnostics.contradictoryOccurrenceIds).toEqual([
      pending.occurrences[0].id,
    ]);
  });

  it("fails closed when runtime occurrence origin is newer than the typed contract", () => {
    const acknowledged = SET_ROW_STATE_FIXTURES.saved.input;
    const projection = projectActiveSetRows({
      ...acknowledged,
      occurrences: [
        { ...acknowledged.occurrences[0], origin: "future_origin" as never },
      ],
    });

    expect(projection.rows[0]).toMatchObject({
      state: "unknown_legacy",
      membership: "unknown",
      result: { id: acknowledged.exercise.sets[0].id },
      message: expect.stringContaining("unsupported origin"),
    });
    expect(projection.rows[0].state).not.toBe("saved");
  });

  it("fails closed when runtime version evidence is newer than the typed contract", () => {
    const acknowledged = SET_ROW_STATE_FIXTURES.saved.input;
    const set = acknowledged.exercise.sets[0];
    const projection = projectActiveSetRows({
      ...acknowledged,
      versionEvidenceBySetId: {
        [set.id]: { state: "future_version", count: 1 } as never,
      },
    });

    expect(projection.rows[0]).toMatchObject({
      state: "unknown_legacy",
      result: { id: set.id },
      message: expect.stringContaining("unsupported version evidence"),
    });
    expect(projection.rows[0].state).not.toBe("saved");
  });

  it("surfaces unlinked and contradictory evidence instead of dropping it", () => {
    const skipped = SET_ROW_STATE_FIXTURES.skipped.input;
    const linkedSet = {
      ...SET_ROW_STATE_FIXTURES.saved.input.exercise.sets[0],
      occurrenceId: skipped.occurrences[0].id,
    };
    const unlinkedSet = {
      ...linkedSet,
      id: "unlinked-result",
      clientKey: "unlinked-client-key",
      occurrenceId: "different-occurrence",
    };
    const projection = projectActiveSetRows({
      ...skipped,
      exercise: { ...skipped.exercise, sets: [linkedSet, unlinkedSet] },
    });

    expect(projection.rows[0]).toMatchObject({
      state: "unknown_legacy",
      result: { id: linkedSet.id },
    });
    expect(projection.diagnostics.contradictoryOccurrenceIds).toEqual([
      skipped.occurrences[0].id,
    ]);
    expect(projection.diagnostics.unlinkedSetIds).toEqual(["unlinked-result"]);
  });

  it("prefers a server acknowledgement over its lingering outbox command", () => {
    const acknowledged = SET_ROW_STATE_FIXTURES.saved.input;
    const lingering =
      SET_ROW_STATE_FIXTURES.retained_locally.input.outboxEntries?.[0];
    if (lingering == null) {
      throw new Error("The retained fixture must include an outbox command");
    }

    const projection = projectActiveSetRows({
      ...acknowledged,
      outboxEntries: [lingering],
    });

    expect(projection.rows[0]).toMatchObject({
      state: "saved",
      result: { note: "Exact performed result" },
    });
    expect(projection.diagnostics.acknowledgedOutboxClientKeys).toEqual([
      lingering.clientKey,
    ]);
  });
});

describe("Phase 0 rest presentation contract", () => {
  it("executes one typed fixture for every rest state", () => {
    expect(Object.keys(REST_STATE_FIXTURES).sort()).toEqual(
      [...ACTIVE_WORKOUT_REST_STATES].sort(),
    );
    for (const fixture of Object.values(REST_STATE_FIXTURES)) {
      expect(projectActiveWorkoutRestPresentation(fixture.input).state).toBe(
        fixture.expectedState,
      );
    }
  });

  it("derives a running countdown from the absolute deadline", () => {
    const fixture = REST_STATE_FIXTURES.running;
    const presentation = projectActiveWorkoutRestPresentation(fixture.input);
    expect(presentation).toMatchObject({
      state: "running",
      remainingSeconds: 30,
      totalSeconds: 60,
    });
  });

  it("executes every durable timer phase explicitly", () => {
    for (const fixture of Object.values(REST_TIMER_PHASE_FIXTURES)) {
      expect(projectActiveWorkoutRestPresentation(fixture.input).state).toBe(
        fixture.expectedState,
      );
    }
  });

  it("keeps completion visible through 3999ms and collapses at 4000ms", () => {
    const timer = REST_STATE_FIXTURES.time_elapsed.input.timer;
    expect(timer?.readyAt).not.toBeNull();
    const readyAt = timer?.readyAt ?? NORTH_STAR_NOW_MS;

    expect(
      projectActiveWorkoutRestPresentation({
        ...REST_STATE_FIXTURES.time_elapsed.input,
        nowMs: readyAt + REST_COMPLETE_CONFIRMATION_MS - 1,
      }).state,
    ).toBe("time_elapsed");
    expect(
      projectActiveWorkoutRestPresentation({
        ...REST_STATE_FIXTURES.time_elapsed.input,
        nowMs: readyAt + REST_COMPLETE_CONFIRMATION_MS,
      }).state,
    ).toBe("inactive");
  });

  it("derives completion from a stale running timer's absolute deadline", () => {
    const timer = REST_STATE_FIXTURES.running.input.timer;
    if (timer == null) {
      throw new Error("The running fixture must include a timer");
    }

    expect(
      projectActiveWorkoutRestPresentation({
        ...REST_STATE_FIXTURES.running.input,
        nowMs: timer.endsAt + REST_COMPLETE_CONFIRMATION_MS - 1,
      }).state,
    ).toBe("time_elapsed");
    expect(
      projectActiveWorkoutRestPresentation({
        ...REST_STATE_FIXTURES.running.input,
        nowMs: timer.endsAt + REST_COMPLETE_CONFIRMATION_MS,
      }).state,
    ).toBe("inactive");
  });

  it("fails closed when runtime rest evidence is newer than the typed contract", () => {
    const timer = REST_STATE_FIXTURES.running.input.timer;
    if (timer == null) {
      throw new Error("The running fixture must include a timer");
    }
    expect(
      projectActiveWorkoutRestPresentation({
        ...REST_STATE_FIXTURES.running.input,
        timer: { ...timer, phase: "future_phase" as never },
      }),
    ).toMatchObject({
      state: "recovery_required",
      message: expect.stringContaining("unsupported phase"),
    });
  });

  it("does not hide a future cue-availability state behind ordinary rest", () => {
    expect(
      projectActiveWorkoutRestPresentation({
        ...REST_STATE_FIXTURES.running.input,
        cueAvailability: "future_availability" as never,
      }),
    ).toMatchObject({
      state: "recovery_required",
      message: expect.stringContaining("unsupported availability"),
    });
  });

  it("does not manufacture successful cue availability when evidence is omitted", () => {
    expect(
      projectActiveWorkoutRestPresentation({
        ...REST_STATE_FIXTURES.running.input,
        cueAvailability: undefined,
      }),
    ).toMatchObject({
      state: "recovery_required",
      message: expect.stringContaining("availability is unknown"),
    });
  });
});

describe("Phase 0 equipment and session state contracts", () => {
  it("executes one typed fixture for every equipment state", () => {
    expect(Object.keys(EQUIPMENT_STATE_FIXTURES).sort()).toEqual(
      [...ACTIVE_WORKOUT_EQUIPMENT_STATES].sort(),
    );
    for (const fixture of Object.values(EQUIPMENT_STATE_FIXTURES)) {
      const presentation = projectActiveWorkoutEquipmentPresentation(
        fixture.input,
      );
      expect(presentation.state).toBe(fixture.expectedState);
      expect(presentation.blocksLogging).toBe(fixture.expectedBlocksLogging);
    }
  });

  it("requires structured equipment limitation evidence", () => {
    const broad = EQUIPMENT_STATE_FIXTURES.unknown_legacy.input.cue;
    const unavailable = projectActiveWorkoutEquipmentPresentation({
      cue: { ...broad, message: "Equipment unavailable" },
    });
    expect(unavailable).toMatchObject({
      state: "unknown_legacy",
      blocksLogging: false,
      limitation: "unknown_legacy",
    });
  });

  it("executes every equipment cue status explicitly", () => {
    for (const fixture of Object.values(EQUIPMENT_CUE_STATUS_FIXTURES)) {
      const presentation = projectActiveWorkoutEquipmentPresentation(
        fixture.input,
      );
      expect(presentation.state).toBe(fixture.expectedState);
      expect(presentation.blocksLogging).toBe(fixture.expectedBlocksLogging);
    }
  });

  it("treats precise broad-only cues such as bodyweight as ready", () => {
    const broad = EQUIPMENT_STATE_FIXTURES.unknown_legacy.input.cue;
    expect(
      projectActiveWorkoutEquipmentPresentation({
        cue: { ...broad, preciseClaimAllowed: true },
      }),
    ).toMatchObject({
      state: "ready_confirmed",
      blocksLogging: false,
      limitation: null,
    });
  });

  it("does not let a ready cue erase a structured equipment limitation", () => {
    const cue = EQUIPMENT_STATE_FIXTURES.ready_confirmed.input.cue;
    expect(
      projectActiveWorkoutEquipmentPresentation({
        cue,
        limitation: "unavailable",
      }),
    ).toMatchObject({
      state: "unavailable",
      blocksLogging: true,
      limitation: "unavailable",
    });
  });

  it("does not infer equipment facts from future runtime states", () => {
    const cue = EQUIPMENT_STATE_FIXTURES.ready_confirmed.input.cue;
    expect(
      projectActiveWorkoutEquipmentPresentation({
        cue: { ...cue, status: "future_status" as never },
      }),
    ).toMatchObject({
      state: "unknown_legacy",
      blocksLogging: false,
      limitation: "unknown_legacy",
    });
    expect(
      projectActiveWorkoutEquipmentPresentation({
        cue,
        selectionRuntime: "future_runtime" as never,
      }),
    ).toMatchObject({
      state: "selection_failed",
      blocksLogging: true,
    });
    expect(
      projectActiveWorkoutEquipmentPresentation({
        cue,
        selectionRuntime: "future_runtime" as never,
        limitation: "unavailable",
      }),
    ).toMatchObject({
      state: "selection_failed",
      blocksLogging: true,
      limitation: "unavailable",
    });
    expect(
      projectActiveWorkoutEquipmentPresentation({
        cue,
        limitation: "future_limitation" as never,
      }),
    ).toMatchObject({
      state: "unknown_legacy",
      blocksLogging: false,
      limitation: "unknown_legacy",
      cue: { message: expect.stringContaining("unsupported limitation") },
    });
    expect(
      projectActiveWorkoutEquipmentPresentation({
        cue,
        selectionRuntime: "pending",
        limitation: "future_limitation" as never,
      }),
    ).toMatchObject({
      state: "selection_pending",
      blocksLogging: true,
      limitation: "unknown_legacy",
      cue: { message: expect.stringContaining("unsupported limitation") },
    });
  });

  it("executes all session-level states through deterministic precedence", () => {
    expect(Object.keys(SESSION_STATE_FIXTURES).sort()).toEqual(
      [...ACTIVE_WORKOUT_SESSION_STATES].sort(),
    );
    for (const [state, evidence] of Object.entries(SESSION_STATE_FIXTURES)) {
      expect(projectActiveWorkoutSessionState(evidence)).toBe(state);
    }
  });

  it("never lets an active failure hide behind a normal entry state", () => {
    expect(
      projectActiveWorkoutSessionState({
        ...SESSION_STATE_FIXTURES.set_entry,
        failureRecovery: true,
        offlineRetention: true,
      }),
    ).toBe("failure_recovery");
  });

  it("keeps recorded-work recovery ahead of completion pending", () => {
    expect(
      projectActiveWorkoutSessionState({
        ...SESSION_STATE_FIXTURES.completion_pending,
        failureRecovery: true,
      }),
    ).toBe("failure_recovery");
  });

  it("keeps finish review ahead of equipment guidance", () => {
    expect(
      projectActiveWorkoutSessionState({
        ...SESSION_STATE_FIXTURES.early_finish_review,
        equipmentDecision: true,
      }),
    ).toBe("early_finish_review");
  });

  it("keeps offline retention ahead of a normal save-pending state", () => {
    expect(
      projectActiveWorkoutSessionState({
        ...SESSION_STATE_FIXTURES.set_entry,
        offlineRetention: true,
        setSavePending: true,
      }),
    ).toBe("offline_retention");
  });

  it("fails closed when a future rest state reaches session precedence", () => {
    expect(
      projectActiveWorkoutSessionState({
        ...SESSION_STATE_FIXTURES.set_entry,
        restState: "future_rest_state" as never,
      }),
    ).toBe("failure_recovery");
  });
});

describe("Phase 0 screenshot contract", () => {
  it("names seven references and every missing hard state without collisions", () => {
    const names = Object.values(ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS);
    expect(names).toHaveLength(15);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "01-set-entry-390x844-115",
      "02-rest-running-390x844-115",
      "03-rest-complete-390x844-115",
      "04-equipment-conflict-390x844-115",
      "05-set-entry-390x844-145",
      "06-rest-running-390x844-145",
      "07-set-entry-320x700-145",
      "08-saving-390x844-115",
      "09-failed-390x844-115",
      "10-keyboard-390x844-115",
      "11-landscape-844x390-115",
      "12-superset-390x844-115",
      "13-correction-390x844-115",
      "14-skip-replace-390x844-115",
      "15-finish-review-390x844-115",
    ]);
  });

  it("keeps all seven approved visual references available", () => {
    for (const name of Object.values(ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS).slice(
      0,
      7,
    )) {
      expect(
        existsSync(
          join(
            process.cwd(),
            "docs/assets/active-workout-north-star",
            `${name}.jpg`,
          ),
        ),
        `Missing North Star reference ${name}.jpg`,
      ).toBe(true);
    }
  });

  it("keeps the current seven-state baseline and keyboard evidence available", () => {
    const baselineNames = [
      ...Object.values(ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS).slice(0, 7),
      ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS.keyboard390x844At115,
    ];
    for (const name of baselineNames) {
      const path = join(
        process.cwd(),
        "docs/assets/active-workout-phase0-baseline",
        `${name}.jpg`,
      );
      expect(existsSync(path), `Missing current baseline ${name}.jpg`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(5_000);
    }
  });

  it("keeps the complete Phase 5 running-product evidence set available", () => {
    const directory = join(
      process.cwd(),
      "docs/assets/active-workout-phase5-qa",
    );
    for (const name of Object.values(ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS)) {
      const path = join(directory, `${name}.jpg`);
      expect(existsSync(path), `Missing Phase 5 evidence ${name}.jpg`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(5_000);
    }
    expect(existsSync(join(directory, "README.md"))).toBe(true);
  });
});
