import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/sessions", () => ({
  correctWorkoutActiveDuration: vi.fn(),
}));
vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DrawerTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import {
  WorkoutActiveDurationCorrection,
  activeDurationCorrectionDraftState,
} from "@/components/history/workout-active-duration-correction";

const dateOnlyOwnerEvidence = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  historyRevision: 2,
  startedAtISO: "2026-07-01T16:00:00.000Z",
  finishedAtISO: null,
  activeDurationSemanticsVersion: 1,
  activeDurationSeconds: 2_700,
  activeDurationBasis: "owner_reported",
};

describe("WorkoutActiveDurationCorrection date-only bounds", () => {
  it("labels absent wall-clock evidence without hiding owner correction", () => {
    const html = renderToStaticMarkup(
      <WorkoutActiveDurationCorrection {...dateOnlyOwnerEvidence} />,
    );
    expect(html).toContain("Correct active duration");
    expect(html).toContain("Wall clock unavailable");
    expect(html).toContain("Active time is unknown");
    expect(html).toContain("original start or finish timestamps");
  });

  it("uses the global bound without inventing wall-clock elapsed time", () => {
    expect(activeDurationCorrectionDraftState({
      ...dateOnlyOwnerEvidence,
      choice: "owner_reported",
      activeMinutes: "10080",
    })).toMatchObject({
      wallClockSeconds: null,
      maxActiveMinutes: 10_080,
      activeSeconds: 604_800,
      ownerReportedValid: true,
      unchanged: false,
      valid: true,
    });
    expect(activeDurationCorrectionDraftState({
      ...dateOnlyOwnerEvidence,
      choice: "owner_reported",
      activeMinutes: "10081",
    })).toMatchObject({ ownerReportedValid: false, valid: false });
  });

  it("disables no-op evidence and enables a reviewed unknown correction", () => {
    expect(activeDurationCorrectionDraftState({
      ...dateOnlyOwnerEvidence,
      choice: "owner_reported",
      activeMinutes: "45",
    })).toMatchObject({ unchanged: true, valid: false });
    expect(activeDurationCorrectionDraftState({
      ...dateOnlyOwnerEvidence,
      choice: "interruption_unknown",
      activeMinutes: "",
    })).toMatchObject({ unchanged: false, valid: true });
  });

  it("retains the wall-clock upper bound when finish evidence exists", () => {
    const withWallClock = {
      ...dateOnlyOwnerEvidence,
      finishedAtISO: "2026-07-01T17:00:00.000Z",
    };
    expect(activeDurationCorrectionDraftState({
      ...withWallClock,
      choice: "owner_reported",
      activeMinutes: "61",
    })).toMatchObject({
      wallClockSeconds: 3_600,
      maxActiveMinutes: 60,
      ownerReportedValid: false,
      valid: false,
    });
  });
});
