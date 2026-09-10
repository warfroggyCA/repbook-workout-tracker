import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { TodayData } from "@/services/today";

const mocks = vi.hoisted(() => ({ getTodayPageData: vi.fn() }));
vi.mock("@/services/today", () => mocks);
vi.mock("@/db", () => ({ getDb: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/user", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "synthetic-owner", profile: { timezone: "America/Toronto" } }),
}));
vi.mock("@/services/session-equipment-requirements", () => ({
  resolveTemplatePreparationEquipmentProjection: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/components/session/workout-start-form", () => ({
  WorkoutStartForm: ({ children }: { children: ReactNode }) => <form>{children}</form>,
}));
vi.mock("@/components/session/active-workout-actions", () => ({ ActiveWorkoutDiscard: () => null }));
vi.mock("@/components/program/scheduled-event-actions", () => ({ ScheduledEventActions: () => null }));
vi.mock("@/components/dashboard/today-add-menu", () => ({ TodayAddMenu: () => null }));

import TodayPage from "@/app/(main)/today/page";

function day(id: string, exerciseId: string, demoExerciseId: string | null) {
  return {
    template: { id, lineageId: `lineage-${id}`, name: id, warmupItems: [] },
    slots: [{
      slot: { id: `slot-${id}`, warmupSets: [] },
      exercise: {
        id: exerciseId, primaryMuscles: ["biceps"], secondaryMuscles: [], catalogReviewed: true, name: "Synthetic curl", family: "Curl", movementPattern: "isolation",
        formDemo: demoExerciseId ? { key: "incline-dumbbell-curl-v102", exerciseId: demoExerciseId } : null,
      },
      prescription: { sets: 3, repRangeMin: 8, repRangeMax: 12, targetLoad: 15, targetLoadUnit: "lb" },
    }],
  } as unknown as TodayData["allTemplates"][number];
}

describe("Today planned exercise form entry", () => {
  let today: TodayData;
  beforeEach(() => {
    const current = day("Day 1", "curl-1", "curl-1");
    const alternate = day("Day 2", "curl-2", "curl-2");
    today = {
      programName: "Synthetic Program", nextTemplate: current, allTemplates: [current, alternate],
      lastDoneByTemplateId: {}, currentLocalDate: "2026-09-10", daysSinceLastSession: null,
      inProgressSessionId: null, inProgressOccurrences: [], schedule: null,
    } as unknown as TodayData;
    mocks.getTodayPageData.mockImplementation(async () => ({ today, pendingRecs: [] }));
  });

  it.each([undefined, "Day 2"])("offers form before starting the selected day (%s)", async (preview) => {
    const html = renderToStaticMarkup(await TodayPage({ searchParams: Promise.resolve({ preview }) }));
    expect(html).toContain('aria-label="View Incline Dumbbell Curl form"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("3 × 8–12");
    expect(html).toContain(`data-day-muscle-summary="lineage-${preview ?? "Day 1"}"`);
    expect(html).toContain("Biceps: 3 direct sets");
    expect(html).toContain(`/program/muscles?day=lineage-${preview ? "Day+2" : "Day+1"}`);
    expect(html).not.toContain("<video");
    expect(html).toContain(preview ? "Planned exercises" : "Preview planned exercises");
  });

  it.each([null, "different-exercise"])("keeps the ordinary icon for missing or stale metadata (%s)", async (descriptorId) => {
    const fallback = day("Day 1", "curl-1", descriptorId);
    today.nextTemplate = fallback;
    today.allTemplates = [fallback];
    const html = renderToStaticMarkup(await TodayPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Synthetic curl");
    expect(html).not.toContain('aria-label="View Incline Dumbbell Curl form"');
    expect(html).not.toContain("<video");
  });
});
