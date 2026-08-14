import { describe, expect, it } from "vitest";
import {
  applyProgramScheduleAdjustments,
  materializeProgramScheduleWindow,
  parseProgramScheduleDocument,
  programScheduleCompletionDate,
  programScheduleDocumentSchema,
  resolveProgramScheduleDay,
  type ProgramScheduleDocument,
} from "@/lib/program-schedule";

function uuid(value: number) {
  return (
    "00000000-0000-4000-8000-" + String(value).padStart(12, "0")
  );
}

function resistance(eventId: number, routineId: number) {
  return {
    id: uuid(eventId),
    kind: "resistance" as const,
    routineLineageId: uuid(routineId),
  };
}

function rest(eventId: number) {
  return { id: uuid(eventId), kind: "rest" as const };
}

function recovery(eventId: number) {
  return { id: uuid(eventId), kind: "recovery" as const };
}

function cardio(eventId: number) {
  return {
    id: uuid(eventId),
    kind: "cardio" as const,
    modality: "Incline walk",
    durationMinutes: { min: 20, max: 30 },
    intensity: "Conversational",
    notes: "Stay relaxed",
  };
}

function fixedDays(firstEventId = 1, firstRoutineId = 101) {
  return [
    {
      isoWeekday: 1,
      event: resistance(firstEventId, firstRoutineId),
    },
    { isoWeekday: 2, event: cardio(firstEventId + 1) },
    { isoWeekday: 3, event: recovery(firstEventId + 2) },
    { isoWeekday: 4, event: rest(firstEventId + 3) },
    {
      isoWeekday: 5,
      event: resistance(firstEventId + 4, firstRoutineId + 1),
    },
    { isoWeekday: 6, event: cardio(firstEventId + 5) },
    { isoWeekday: 7, event: rest(firstEventId + 6) },
  ];
}

function fixedWeekDocument() {
  return {
    schemaVersion: "program-schedule/1" as const,
    startsOn: "2026-03-02",
    targetEndsOn: "2026-03-08",
    phases: [
      {
        id: uuid(201),
        name: "Foundation",
        order: 1,
        boundary: {
          kind: "program_week_range" as const,
          startWeek: 1,
          endWeek: 1,
        },
        schedule: {
          kind: "fixed_7_day" as const,
          days: fixedDays(),
        },
      },
    ],
  };
}

function fixedDateDocument(startsOn: string, endsOn: string) {
  return {
    schemaVersion: "program-schedule/1" as const,
    startsOn,
    targetEndsOn: endsOn,
    phases: [
      {
        id: uuid(202),
        name: "Calendar phase",
        order: 1,
        boundary: {
          kind: "local_date_range" as const,
          startsOn,
          endsOn,
        },
        schedule: {
          kind: "fixed_7_day" as const,
          days: fixedDays(20, 120),
        },
      },
    ],
  };
}

function rollingDocument() {
  return {
    schemaVersion: "program-schedule/1" as const,
    startsOn: "2026-03-05",
    targetEndsOn: "2026-04-05",
    phases: [
      {
        id: uuid(301),
        name: "Eight-day rotation",
        order: 1,
        boundary: {
          kind: "local_date_range" as const,
          startsOn: "2026-03-05",
          endsOn: "2026-04-05",
        },
        schedule: {
          kind: "rolling" as const,
          lengthDays: 8,
          days: Array.from({ length: 8 }, (_, index) => ({
            position: index + 1,
            event: resistance(310 + index, 410 + index),
          })),
        },
      },
    ],
  };
}

function twoPhaseDocument() {
  return {
    schemaVersion: "program-schedule/1" as const,
    startsOn: "2026-03-02",
    targetEndsOn: "2026-03-05",
    phases: [
      {
        id: uuid(501),
        name: "Accumulation",
        order: 1,
        boundary: {
          kind: "local_date_range" as const,
          startsOn: "2026-03-02",
          endsOn: "2026-03-03",
        },
        schedule: {
          kind: "rolling" as const,
          lengthDays: 2,
          days: [
            { position: 1, event: resistance(511, 611) },
            { position: 2, event: resistance(512, 612) },
          ],
        },
      },
      {
        id: uuid(502),
        name: "Realization",
        order: 2,
        boundary: {
          kind: "local_date_range" as const,
          startsOn: "2026-03-04",
          endsOn: "2026-03-05",
        },
        schedule: {
          kind: "rolling" as const,
          lengthDays: 2,
          days: [
            { position: 1, event: resistance(513, 613) },
            { position: 2, event: resistance(514, 614) },
          ],
        },
      },
    ],
  };
}

function torontoLocalDate(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: "year" | "month" | "day") =>
    parts.find((candidate) => candidate.type === type)?.value;
  return part("year") + "-" + part("month") + "-" + part("day");
}

describe("program-schedule/1 document", () => {
  it("validates and deeply freezes a fixed intentional event for every ISO weekday", () => {
    const document = parseProgramScheduleDocument(fixedWeekDocument());

    expect(document.schemaVersion).toBe("program-schedule/1");
    expect(document.phases[0].schedule.days).toHaveLength(7);
    expect(programScheduleCompletionDate(document)).toBe("2026-03-08");
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.phases)).toBe(true);
    expect(Object.isFrozen(document.phases[0].schedule.days[0].event)).toBe(
      true,
    );
    expect(() => {
      (document as unknown as { startsOn: string }).startsOn = "2026-01-01";
    }).toThrow();
  });

  it("derives the finite completion horizon when targetEndsOn is omitted", () => {
    const source = fixedWeekDocument();
    Reflect.deleteProperty(source, "targetEndsOn");
    Object.assign(source.phases[0], { notes: "  Build patiently  " });

    const document = parseProgramScheduleDocument(source);
    expect(programScheduleCompletionDate(document)).toBe("2026-03-08");
    expect(document.phases[0].notes).toBe("Build patiently");
  });

  it("resolves all seven fixed weekdays with explicit lineage and cycle position", () => {
    const document = parseProgramScheduleDocument(fixedWeekDocument());
    const resolved = materializeProgramScheduleWindow(document, {
      startsOn: "2026-03-02",
      endsOn: "2026-03-08",
    });

    expect(resolved.map((day) => day.state)).toEqual(
      Array(7).fill("scheduled"),
    );
    expect(resolved.map((day) => day.cyclePosition)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(resolved.map((day) => day.eventKind)).toEqual([
      "resistance",
      "cardio",
      "recovery",
      "rest",
      "resistance",
      "cardio",
      "rest",
    ]);
    expect(resolved[0]).toMatchObject({
      phaseId: uuid(201),
      phaseName: "Foundation",
      routineLineageId: uuid(101),
      plannedLocalDate: "2026-03-02",
      nominalProgramWeek: 1,
    });
    expect(resolved[1].routineLineageId).toBeNull();
    expect(resolved[1].intentSnapshot).toMatchObject({
      kind: "cardio",
      modality: "Incline walk",
      durationMinutes: { min: 20, max: 30 },
    });
  });

  it("keeps an eight-day rotation continuous across Mondays", () => {
    const document = parseProgramScheduleDocument(rollingDocument());
    const resolved = materializeProgramScheduleWindow(document, {
      startsOn: "2026-03-05",
      endsOn: "2026-03-16",
    });

    expect(resolved.map((day) => day.cyclePosition)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4,
    ]);
    expect(resolveProgramScheduleDay(document, "2026-03-09")).toMatchObject({
      cyclePosition: 5,
      plannedLocalDate: "2026-03-09",
    });
    expect(resolveProgramScheduleDay(document, "2026-03-16")).toMatchObject({
      cyclePosition: 4,
      plannedLocalDate: "2026-03-16",
    });
  });

  it("activates and deactivates phase boundaries without duplicating A-D routine lineage", () => {
    const document = parseProgramScheduleDocument(twoPhaseDocument());
    const resolved = materializeProgramScheduleWindow(document, {
      startsOn: "2026-03-02",
      endsOn: "2026-03-05",
    });

    expect(resolved.map((day) => day.phaseName)).toEqual([
      "Accumulation",
      "Accumulation",
      "Realization",
      "Realization",
    ]);
    expect(resolved.map((day) => day.routineLineageId)).toEqual([
      uuid(611),
      uuid(612),
      uuid(613),
      uuid(614),
    ]);
    expect(new Set(resolved.map((day) => day.routineLineageId)).size).toBe(4);
  });

  it("makes before-start, defensive missing-phase, and after-complete states explicit", () => {
    const document = parseProgramScheduleDocument(
      fixedDateDocument("2026-03-02", "2026-03-08"),
    );
    const missingPhaseDocument = {
      ...document,
      phases: [],
    } as unknown as ProgramScheduleDocument;

    expect(resolveProgramScheduleDay(document, "2026-03-01")).toMatchObject({
      state: "before_start",
      phaseId: null,
      nominalProgramWeek: null,
    });
    expect(
      resolveProgramScheduleDay(missingPhaseDocument, "2026-03-02"),
    ).toMatchObject({
      state: "missing_phase",
      phaseId: null,
      nominalProgramWeek: 1,
    });
    expect(resolveProgramScheduleDay(document, "2026-03-05").state).toBe(
      "scheduled",
    );
    expect(resolveProgramScheduleDay(document, "2026-03-09")).toMatchObject({
      state: "after_complete",
      phaseId: null,
      nominalProgramWeek: 2,
    });
  });

  it("supports inclusive explicit local-date phase boundaries", () => {
    const document = parseProgramScheduleDocument(
      fixedDateDocument("2026-04-10", "2026-04-12"),
    );

    expect(resolveProgramScheduleDay(document, "2026-04-10").state).toBe(
      "scheduled",
    );
    expect(resolveProgramScheduleDay(document, "2026-04-12").state).toBe(
      "scheduled",
    );
    expect(resolveProgramScheduleDay(document, "2026-04-13").state).toBe(
      "after_complete",
    );
  });

  it("rejects duplicate, gapped, overlapping, and malformed definitions", () => {
    const duplicatePhase = twoPhaseDocument();
    duplicatePhase.phases[1].id = duplicatePhase.phases[0].id;

    const gappedPhaseOrder = twoPhaseDocument();
    gappedPhaseOrder.phases[1].order = 3;

    const overlappingPhases = twoPhaseDocument();
    overlappingPhases.phases[1].boundary.startsOn = "2026-03-03";

    const gappedPhaseDates = twoPhaseDocument();
    gappedPhaseDates.phases[1].boundary.startsOn = "2026-03-05";

    const targetDoesNotMatchFinalPhase = twoPhaseDocument();
    targetDoesNotMatchFinalPhase.targetEndsOn = "2026-03-06";

    const duplicateEvent = fixedWeekDocument();
    duplicateEvent.phases[0].schedule.days[1].event.id =
      duplicateEvent.phases[0].schedule.days[0].event.id;

    const gappedFixedWeekdays = fixedWeekDocument();
    gappedFixedWeekdays.phases[0].schedule.days[6].isoWeekday = 6;

    const gappedRollingPositions = rollingDocument();
    gappedRollingPositions.phases[0].schedule.days[1].position = 3;

    for (const invalid of [
      duplicatePhase,
      gappedPhaseOrder,
      overlappingPhases,
      gappedPhaseDates,
      targetDoesNotMatchFinalPhase,
      duplicateEvent,
      gappedFixedWeekdays,
      gappedRollingPositions,
    ]) {
      expect(programScheduleDocumentSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("requires resistance lineage and forbids lineage on non-resistance events", () => {
    const missingLineage = fixedWeekDocument();
    delete (
      missingLineage.phases[0].schedule.days[0].event as {
        routineLineageId?: string;
      }
    ).routineLineageId;

    const cardioWithLineage = fixedWeekDocument();
    Object.assign(cardioWithLineage.phases[0].schedule.days[1].event, {
      routineLineageId: uuid(999),
    });

    expect(
      programScheduleDocumentSchema.safeParse(missingLineage).success,
    ).toBe(false);
    expect(
      programScheduleDocumentSchema.safeParse(cardioWithLineage).success,
    ).toBe(false);
  });

  it("rejects embedded routine contents instead of duplicating routine definitions", () => {
    const source = fixedWeekDocument();
    Object.assign(source.phases[0].schedule.days[0].event, {
      routine: {
        name: "Embedded routine",
        exercises: [{ name: "Synthetic press" }],
      },
    });

    expect(programScheduleDocumentSchema.safeParse(source).success).toBe(false);

    const parsed = parseProgramScheduleDocument(fixedWeekDocument());
    const event = parsed.phases[0].schedule.days[0].event;
    expect(Object.keys(event).sort()).toEqual([
      "id",
      "kind",
      "routineLineageId",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("exercises");
  });

  it("validates cardio duration ranges", () => {
    const source = fixedWeekDocument();
    const event = source.phases[0].schedule.days[1].event;
    if (event.kind !== "cardio") throw new Error("Expected cardio fixture.");
    event.durationMinutes = { min: 45, max: 20 };

    expect(programScheduleDocumentSchema.safeParse(source).success).toBe(false);
  });
});

describe("schedule adjustment rules", () => {
  it("shifts the selected rolling occurrence and every later occurrence without reordering or compression", () => {
    const document = parseProgramScheduleDocument(rollingDocument());
    const materialized = materializeProgramScheduleWindow(document, {
      startsOn: "2026-03-05",
      endsOn: "2026-03-12",
    });
    const result = applyProgramScheduleAdjustments(materialized, [
      {
        kind: "shift_rolling",
        selected: {
          eventId: uuid(311),
          plannedLocalDate: "2026-03-06",
        },
        days: 2,
      },
    ]);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.occurrences.map((item) => item.scheduledLocalDate)).toEqual([
      "2026-03-05",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
      "2026-03-14",
    ]);
    expect(result.occurrences.map((item) => item.plannedLocalDate)).toEqual([
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
    ]);
    expect(
      new Set(result.occurrences.map((item) => item.scheduledLocalDate)).size,
    ).toBe(8);
    expect(Object.isFrozen(result.occurrences)).toBe(true);
  });

  it("marks only the selected occurrence skipped", () => {
    const document = parseProgramScheduleDocument(rollingDocument());
    const materialized = materializeProgramScheduleWindow(document, {
      startsOn: "2026-03-05",
      endsOn: "2026-03-12",
    });
    const result = applyProgramScheduleAdjustments(materialized, [
      {
        kind: "skip",
        selected: {
          eventId: uuid(312),
          plannedLocalDate: "2026-03-07",
        },
      },
    ]);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(
      result.occurrences.filter((item) => item.attendance === "skipped"),
    ).toHaveLength(1);
    expect(result.occurrences[2]).toMatchObject({
      eventId: uuid(312),
      attendance: "skipped",
      scheduledLocalDate: "2026-03-07",
    });
    expect(result.occurrences[3].scheduledLocalDate).toBe("2026-03-08");
  });

  it("applies an explicit manual reschedule when it has no resistance collision", () => {
    const document = parseProgramScheduleDocument(rollingDocument());
    const materialized = materializeProgramScheduleWindow(document, {
      startsOn: "2026-03-05",
      endsOn: "2026-03-12",
    });
    const result = applyProgramScheduleAdjustments(materialized, [
      {
        kind: "manual_reschedule",
        selected: {
          eventId: uuid(310),
          plannedLocalDate: "2026-03-05",
        },
        toLocalDate: "2026-03-15",
      },
    ]);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.occurrences[0]).toMatchObject({
      plannedLocalDate: "2026-03-05",
      scheduledLocalDate: "2026-03-15",
      timingAdjustments: ["manual_reschedule"],
    });
    expect(result.occurrences[1].scheduledLocalDate).toBe("2026-03-06");
  });

  it("rejects silent same-day resistance compression", () => {
    const document = parseProgramScheduleDocument(rollingDocument());
    const materialized = materializeProgramScheduleWindow(document, {
      startsOn: "2026-03-05",
      endsOn: "2026-03-12",
    });
    const result = applyProgramScheduleAdjustments(materialized, [
      {
        kind: "manual_reschedule",
        selected: {
          eventId: uuid(310),
          plannedLocalDate: "2026-03-05",
        },
        toLocalDate: "2026-03-06",
      },
    ]);

    expect(result).toEqual({
      status: "rejected",
      reason: "same_day_resistance_collision",
      adjustmentIndex: 0,
    });
  });

  it("rejects rolling shifts for fixed-calendar events", () => {
    const document = parseProgramScheduleDocument(fixedWeekDocument());
    const materialized = materializeProgramScheduleWindow(document, {
      startsOn: "2026-03-02",
      endsOn: "2026-03-08",
    });
    const result = applyProgramScheduleAdjustments(materialized, [
      {
        kind: "shift_rolling",
        selected: {
          eventId: uuid(1),
          plannedLocalDate: "2026-03-02",
        },
        days: 1,
      },
    ]);

    expect(result).toMatchObject({
      status: "rejected",
      reason: "not_rolling_occurrence",
    });
  });
});

describe("civil-date materialization across Toronto DST", () => {
  it("keeps spring-forward local dates consecutive across a 23-hour interval", () => {
    const before = new Date("2026-03-08T05:30:00.000Z");
    const after = new Date("2026-03-09T04:30:00.000Z");
    expect(after.getTime() - before.getTime()).toBe(23 * 60 * 60 * 1_000);
    const startsOn = torontoLocalDate(before);
    const endsOn = torontoLocalDate(after);
    expect([startsOn, endsOn]).toEqual(["2026-03-08", "2026-03-09"]);

    const document = parseProgramScheduleDocument(
      fixedDateDocument(startsOn, endsOn),
    );
    expect(
      materializeProgramScheduleWindow(document, {
        startsOn,
        endsOn,
      }).map((day) => day.plannedLocalDate),
    ).toEqual(["2026-03-08", "2026-03-09"]);
  });

  it("keeps fall-back local dates consecutive across a 25-hour interval", () => {
    const before = new Date("2026-11-01T04:30:00.000Z");
    const after = new Date("2026-11-02T05:30:00.000Z");
    expect(after.getTime() - before.getTime()).toBe(25 * 60 * 60 * 1_000);
    const startsOn = torontoLocalDate(before);
    const endsOn = torontoLocalDate(after);
    expect([startsOn, endsOn]).toEqual(["2026-11-01", "2026-11-02"]);

    const document = parseProgramScheduleDocument(
      fixedDateDocument(startsOn, endsOn),
    );
    expect(
      materializeProgramScheduleWindow(document, {
        startsOn,
        endsOn,
      }).map((day) => day.plannedLocalDate),
    ).toEqual(["2026-11-01", "2026-11-02"]);
  });
});
