import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResumeWorkoutStatus } from "@/components/dashboard/resume-workout-status";

describe("ResumeWorkoutStatus", () => {
  it("claims nothing about saving or the next step before this device is read", () => {
    const html = renderToStaticMarkup(
      <ResumeWorkoutStatus
        ownerId="20000000-0000-4000-8000-000000000001"
        sessionId="30000000-0000-4000-8000-000000000001"
        upNext={{ title: "Barbell Back Squat · set 2", detail: "6–8 reps · 95 lb" }}
      />,
    );
    expect(html).toBe("");
  });
});
