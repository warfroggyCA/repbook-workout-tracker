import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  auditLogs,
  exercises,
  scheduledProgramEvents,
  userProfiles,
  users,
  workoutTemplates,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  adjustScheduledProgramEvent,
  completeNonResistanceScheduledEvent,
  getCurrentProgramSchedule,
  publishProgramSchedule,
} from "@/services/program-schedules";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

function fixedDocument(
  firstLineageId: string,
  secondLineageId: string,
  overrides: { startsOn?: string; phaseName?: string } = {},
) {
  const startsOn = overrides.startsOn ?? "2026-08-10";
  return {
    schemaVersion: "program-schedule/1" as const,
    startsOn,
    targetEndsOn: "2026-08-16",
    phases: [
      {
        id: crypto.randomUUID(),
        name: overrides.phaseName ?? "Foundation",
        order: 1,
        boundary: {
          kind: "program_week_range" as const,
          startWeek: 1,
          endWeek: 1,
        },
        schedule: {
          kind: "fixed_7_day" as const,
          days: [
            {
              isoWeekday: 1,
              event: {
                id: crypto.randomUUID(),
                kind: "resistance" as const,
                routineLineageId: firstLineageId,
              },
            },
            {
              isoWeekday: 2,
              event: {
                id: crypto.randomUUID(),
                kind: "cardio" as const,
                modality: "Elliptical",
                durationMinutes: { min: 20, max: 25 },
                intensity: "RPE 3-4",
              },
            },
            {
              isoWeekday: 3,
              event: {
                id: crypto.randomUUID(),
                kind: "resistance" as const,
                routineLineageId: secondLineageId,
              },
            },
            ...Array.from({ length: 4 }, (_, index) => ({
              isoWeekday: index + 4,
              event: {
                id: crypto.randomUUID(),
                kind: (index === 0 ? "recovery" : "rest") as
                  | "recovery"
                  | "rest",
              },
            })),
          ],
        },
      },
    ],
  };
}

function rollingDocument(lineageId: string) {
  return {
    schemaVersion: "program-schedule/1" as const,
    startsOn: "2026-08-10",
    targetEndsOn: "2026-08-17",
    phases: [
      {
        id: crypto.randomUUID(),
        name: "Eight day rotation",
        order: 1,
        boundary: {
          kind: "local_date_range" as const,
          startsOn: "2026-08-10",
          endsOn: "2026-08-17",
        },
        schedule: {
          kind: "rolling" as const,
          lengthDays: 8,
          days: Array.from({ length: 8 }, (_, index) => ({
            position: index + 1,
            event:
              index === 1
                ? {
                    id: crypto.randomUUID(),
                    kind: "cardio" as const,
                    modality: "Walk",
                    durationMinutes: { min: 20, max: 20 },
                  }
                : {
                    id: crypto.randomUUID(),
                    kind: "resistance" as const,
                    routineLineageId: lineageId,
                  },
          })),
        },
      },
    ],
  };
}

describe("Program schedule service", () => {
  let database: TestDatabase;
  let userId: string;
  let programId: string;
  let programVersionId: string;
  let firstTemplateId: string;
  let firstLineageId: string;
  let secondLineageId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    userId = crypto.randomUUID();
    await database.db.insert(users).values({
      id: userId,
      email: `program-schedule-${userId}@example.com`,
    });
    await database.db.insert(userProfiles).values({
      userId,
      timezone: "America/Toronto",
      unit: "lb",
    });
    const exerciseId = crypto.randomUUID();
    await database.db.insert(exercises).values({
      id: exerciseId,
      name: `Schedule press ${exerciseId}`,
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
    });
    const activated = await activateProgramAtomically(database.db, {
      userId,
      loadUnit: "lb",
      programName: "Simple scheduled Program",
      days: [
        {
          name: "Routine A",
          exercises: [
            {
              exerciseId,
              sets: 3,
              repMin: 6,
              repMax: 8,
              targetLoad: 100,
              targetLoadUnit: "lb",
              restSec: 90,
              supersetKey: null,
              notes: null,
            },
          ],
        },
        {
          name: "Routine B",
          exercises: [
            {
              exerciseId,
              sets: 2,
              repMin: 8,
              repMax: 10,
              targetLoad: 80,
              targetLoadUnit: "lb",
              restSec: 60,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Create schedule service fixture",
      auditAction: "program.activate",
      auditSummary: "Activated schedule service fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    programId = activated.programId;
    programVersionId = activated.programVersionId;
    const templates = await database.db.query.workoutTemplates.findMany({
      where: eq(workoutTemplates.programVersionId, programVersionId),
      orderBy: asc(workoutTemplates.orderIdx),
    });
    firstTemplateId = templates[0].id;
    firstLineageId = templates[0].lineageId;
    secondLineageId = templates[1].lineageId;
  }, 30_000);

  afterEach(async () => database.close());

  async function publish(
    document: unknown,
    overrides: Partial<Parameters<typeof publishProgramSchedule>[2]> = {},
  ) {
    return publishProgramSchedule(database.db, userId, {
      programId,
      sourceProgramVersionId: programVersionId,
      expectedCurrentScheduleVersionId: null,
      requestId: crypto.randomUUID(),
      timezone: "America/Toronto",
      document,
      ...overrides,
    });
  }

  it("publishes one finite schedule without cloning or changing routines", async () => {
    const before = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.id, firstTemplateId),
      with: { exercises: { with: { prescriptions: true } } },
    });
    const result = await publish(
      fixedDocument(firstLineageId, secondLineageId),
    );
    expect(result).toMatchObject({
      outcome: "published",
      versionNo: 1,
      eventCount: 7,
    });
    const current = await getCurrentProgramSchedule(
      database.db,
      userId,
      programId,
    );
    expect(current?.nextEvent).toMatchObject({
      kind: "resistance",
      routineLineageId: firstLineageId,
      currentLocalDate: "2026-08-10",
      status: "scheduled",
    });
    expect(
      await database.db.query.workoutTemplates.findFirst({
        where: eq(workoutTemplates.id, firstTemplateId),
        with: { exercises: { with: { prescriptions: true } } },
      }),
    ).toEqual(before);
  });

  it("replays an exact request and rejects conflicting reuse", async () => {
    const requestId = crypto.randomUUID();
    const document = fixedDocument(firstLineageId, secondLineageId);
    const first = await publish(document, { requestId });
    expect(first.outcome).toBe("published");
    await expect(publish(document, { requestId })).resolves.toMatchObject({
      outcome: "replayed",
      scheduleVersionId:
        first.outcome === "published" ? first.scheduleVersionId : "",
    });
    await expect(
      publish(fixedDocument(firstLineageId, secondLineageId, {
        phaseName: "Changed",
      }), { requestId }),
    ).resolves.toEqual({ outcome: "conflict" });
    expect(
      await database.db.query.programScheduleVersions.findMany(),
    ).toHaveLength(1);
  });

  it("rejects missing routine lineage, cross-owner access, and stale publication", async () => {
    await expect(
      publish(fixedDocument(crypto.randomUUID(), secondLineageId)),
    ).resolves.toEqual({ outcome: "conflict" });
    const published = await publish(
      fixedDocument(firstLineageId, secondLineageId),
    );
    if (published.outcome !== "published") throw new Error("Publish failed.");
    await expect(
      publish(
        fixedDocument(firstLineageId, secondLineageId, {
          phaseName: "Version 2",
        }),
      ),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      publishProgramSchedule(database.db, crypto.randomUUID(), {
        programId,
        sourceProgramVersionId: programVersionId,
        expectedCurrentScheduleVersionId: published.scheduleVersionId,
        requestId: crypto.randomUUID(),
        timezone: "America/Toronto",
        document: fixedDocument(firstLineageId, secondLineageId),
      }),
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("replaces a schedule only while every occurrence is untouched", async () => {
    const first = await publish(
      fixedDocument(firstLineageId, secondLineageId),
    );
    if (first.outcome !== "published") throw new Error("Publish failed.");
    const second = await publish(
      fixedDocument(firstLineageId, secondLineageId, {
        phaseName: "Revised",
      }),
      { expectedCurrentScheduleVersionId: first.scheduleVersionId },
    );
    expect(second).toMatchObject({ outcome: "published", versionNo: 2 });
    const oldAfter = await database.db.query.scheduledProgramEvents.findMany({
      where: eq(
        scheduledProgramEvents.scheduleVersionId,
        first.scheduleVersionId,
      ),
      orderBy: asc(scheduledProgramEvents.sequenceNo),
    });
    expect(oldAfter.every((event) => event.status === "superseded")).toBe(
      true,
    );
    const current = await getCurrentProgramSchedule(
      database.db,
      userId,
      programId,
    );
    expect(current?.version.id).toBe(
      second.outcome === "published" ? second.scheduleVersionId : "",
    );
    expect(current?.nextEvent?.currentLocalDate).toBe("2026-08-10");
  });

  it.each([
    "started",
    "completed",
    "skipped",
    "abandoned",
    "manual-rescheduled",
    "rolling-shifted",
  ])(
    "rejects schedule replacement after an occurrence is %s",
    async (state) => {
      const document =
        state === "rolling-shifted"
          ? rollingDocument(firstLineageId)
          : fixedDocument(firstLineageId, secondLineageId);
      const first = await publish(document);
      if (first.outcome !== "published") throw new Error("Publish failed.");
      const events = await database.db.query.scheduledProgramEvents.findMany({
        where: eq(
          scheduledProgramEvents.scheduleVersionId,
          first.scheduleVersionId,
        ),
        orderBy: asc(scheduledProgramEvents.sequenceNo),
      });
      const resolvedAt = new Date("2026-08-10T18:00:00.000Z");
      if (state === "started") {
        await database.db
          .update(scheduledProgramEvents)
          .set({ status: "started", revision: 1 })
          .where(eq(scheduledProgramEvents.id, events[0].id));
      } else if (
        state === "completed" ||
        state === "skipped" ||
        state === "abandoned"
      ) {
        await database.db
          .update(scheduledProgramEvents)
          .set({ status: state, revision: 1, resolvedAt })
          .where(eq(scheduledProgramEvents.id, events[0].id));
      } else {
        await database.db
          .update(scheduledProgramEvents)
          .set({
            currentLocalDate: "2026-08-11",
            adjustmentKind:
              state === "rolling-shifted" ? "shift" : "manual",
            revision: 1,
          })
          .where(eq(scheduledProgramEvents.id, events[0].id));
      }
      const before = await database.db.query.scheduledProgramEvents.findMany({
        where: eq(
          scheduledProgramEvents.scheduleVersionId,
          first.scheduleVersionId,
        ),
        orderBy: asc(scheduledProgramEvents.sequenceNo),
      });

      await expect(
        publish(document, {
          expectedCurrentScheduleVersionId: first.scheduleVersionId,
        }),
      ).resolves.toEqual({ outcome: "conflict" });

      expect(
        await database.db.query.programScheduleVersions.findMany(),
      ).toHaveLength(1);
      expect(
        await database.db.query.scheduledProgramEvents.findMany({
          where: eq(
            scheduledProgramEvents.scheduleVersionId,
            first.scheduleVersionId,
          ),
          orderBy: asc(scheduledProgramEvents.sequenceNo),
        }),
      ).toEqual(before);
      expect(
        (await database.db.query.programSchedules.findFirst())?.currentVersionId,
      ).toBe(first.scheduleVersionId);
    },
  );

  it("shifts a rolling tail, rejects stale revisions, and replays exactly", async () => {
    const published = await publish(rollingDocument(firstLineageId));
    if (published.outcome !== "published") throw new Error("Publish failed.");
    const events = await database.db.query.scheduledProgramEvents.findMany({
      where: eq(
        scheduledProgramEvents.scheduleVersionId,
        published.scheduleVersionId,
      ),
      orderBy: asc(scheduledProgramEvents.sequenceNo),
    });
    const requestId = crypto.randomUUID();
    const shifted = await adjustScheduledProgramEvent(database.db, userId, {
      eventId: events[1].id,
      expectedRevision: 0,
      requestId,
      adjustment: { kind: "shift_rolling", days: 2 },
    });
    expect(shifted).toEqual({ outcome: "applied", affected: 7 });
    await expect(
      adjustScheduledProgramEvent(database.db, userId, {
        eventId: events[1].id,
        expectedRevision: 0,
        requestId,
        adjustment: { kind: "shift_rolling", days: 2 },
      }),
    ).resolves.toEqual({ outcome: "replayed", affected: 7 });
    const after = await database.db.query.scheduledProgramEvents.findMany({
      where: eq(
        scheduledProgramEvents.scheduleVersionId,
        published.scheduleVersionId,
      ),
      orderBy: asc(scheduledProgramEvents.sequenceNo),
    });
    expect(after.map((event) => event.currentLocalDate)).toEqual([
      "2026-08-10",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
    ]);
    await expect(
      adjustScheduledProgramEvent(database.db, userId, {
        eventId: events[1].id,
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
        adjustment: { kind: "skip" },
      }),
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("requires explicit non-resistance completion and rejects same-day resistance compression", async () => {
    const published = await publish(
      fixedDocument(firstLineageId, secondLineageId),
    );
    if (published.outcome !== "published") throw new Error("Publish failed.");
    const events = await database.db.query.scheduledProgramEvents.findMany({
      where: eq(
        scheduledProgramEvents.scheduleVersionId,
        published.scheduleVersionId,
      ),
      orderBy: asc(scheduledProgramEvents.sequenceNo),
    });
    await expect(
      adjustScheduledProgramEvent(database.db, userId, {
        eventId: events[2].id,
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
        adjustment: {
          kind: "manual_reschedule",
          toLocalDate: events[0].currentLocalDate,
        },
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      completeNonResistanceScheduledEvent(database.db, userId, {
        eventId: events[0].id,
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      completeNonResistanceScheduledEvent(database.db, userId, {
        eventId: events[1].id,
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
        completedAt: new Date("2026-08-11T17:00:00.000Z"),
      }),
    ).resolves.toEqual({ outcome: "applied", affected: 1 });
    expect(
      await database.db.query.scheduledProgramEvents.findFirst({
        where: and(
          eq(scheduledProgramEvents.id, events[1].id),
          eq(scheduledProgramEvents.status, "completed"),
        ),
      }),
    ).toMatchObject({ revision: 1, resolvedAt: expect.any(Date) });
    expect(
      await database.db.query.auditLogs.findMany({
        where: eq(auditLogs.userId, userId),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "program_schedule.complete_non_resistance",
        }),
      ]),
    );
  });
});
