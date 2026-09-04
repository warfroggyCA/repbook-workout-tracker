import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTrainingDigest } from "@/services/digest";
import { getHistoryReport } from "@/services/history-report";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedV2H02CadenceTargetsTime,
  V2_H02_NOW,
  type V2H02CadenceFixture,
} from "../helpers/v2-h02-cadence-targets-time";

describe("V2 H02 cadence and planned-set outcomes", () => {
  let database: TestDatabase;
  let fixture: V2H02CadenceFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedV2H02CadenceTargetsTime(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("derives one neutral calendar cadence and one versioned target summary from retained evidence", async () => {
    const report = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    expect(report.cadence).toMatchObject({
      algorithmVersion: "calendar-cadence-v1",
      completedSessions: 5,
      completeWeeks: 3,
      averageSessionsPerCompleteWeek: 1.33,
      weekly: [
        { weekStart: "2026-07-13", sessions: 2 },
        { weekStart: "2026-07-20", sessions: 1 },
        { weekStart: "2026-07-27", sessions: 1 },
      ],
      medianGapDays: 5.5,
      currentGapDays: 1,
      unlinkedSessions: 2,
      currentPreference: {
        sessionsPerWeek: 3,
        comparison: "below",
      },
    });
    expect(report.cadence.currentPreference.limitation).toContain(
      "not an adherence percentage",
    );
    expect(report.cadence.programDayExposures).toEqual([
      {
        lineageId: fixture.dayLineages.first,
        sessions: 2,
        labels: [
          { label: "Push renamed", sessions: 1 },
          { label: "Strength A", sessions: 1 },
        ],
      },
      {
        lineageId: fixture.dayLineages.second,
        sessions: 1,
        labels: [{ label: "Strength B", sessions: 1 }],
      },
    ]);
    expect(report.overview.targetOutcomes).toEqual({
      algorithmVersion: "prescription-outcome-v2",
      below: 1,
      at: 2,
      above: 1,
      unknown: 1,
      supported: 4,
      atOrAboveRate: 75,
    });
    expect(report.overview).not.toHaveProperty("planCompletionRate");
  });

  it("keeps History and Coach on the same projections without reading stale booleans", async () => {
    const digest = await buildTrainingDigest(
      database.db,
      fixture.userId,
      new Date("2026-07-08T16:00:00.000Z"),
      V2_H02_NOW,
    );
    expect(digest.cadence).toMatchObject({
      algorithmVersion: "calendar-cadence-v1",
      completedSessions: 5,
      averageSessionsPerCompleteWeek: 1.33,
      medianGapDays: 5.5,
      currentGapDays: 1,
    });
    expect(digest.targetOutcomes).toEqual({
      algorithmVersion: "prescription-outcome-v2",
      below: 1,
      at: 2,
      above: 1,
      unknown: 1,
      supported: 4,
      atOrAboveRate: 75,
    });
    expect(digest).not.toHaveProperty("adherence");
  });
});
