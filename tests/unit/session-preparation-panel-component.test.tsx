import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionPreparationPanel } from "@/components/session/session-preparation-panel";
import type {
  SessionPreparationEquipmentProjection,
  SessionPreparationRequirementRow,
} from "@/lib/session-equipment-requirements";

function row(
  key: string,
  status: SessionPreparationRequirementRow["status"],
  overrides: Partial<SessionPreparationRequirementRow> = {},
): SessionPreparationRequirementRow {
  return {
    key,
    label: `Equipment ${key}`,
    classification: status === "available" ? "confirmed" : "attention",
    status,
    statusText: status === "available"
      ? "Available"
      : status === "unavailable"
        ? "Unavailable"
        : status === "incompatible"
          ? "No compatible saved setup"
        : "Availability unknown",
    usageContext: `Used for Exercise ${key}`,
    equipmentType: "dumbbell",
    equipmentDefinitionId: null,
    requiredProfileKind: null,
    requiredAttachmentKind: null,
    requiresKnownGeometry: false,
    minWeight: null,
    sourceExerciseIds: [`exercise-${key}`],
    sourceRequirementIds: [`requirement-${key}`],
    ...overrides,
  };
}

function projection(
  overrides: Partial<SessionPreparationEquipmentProjection> = {},
): SessionPreparationEquipmentProjection {
  return {
    state: "available",
    statusText: "Equipment is available.",
    evidenceState: "retained",
    sourceHistoryRevision: 0,
    rows: [],
    ...overrides,
  };
}

describe("SessionPreparationPanel", () => {
  it("keeps attention first, discloses only surplus confirmed rows, and offers a touch-safe jump", () => {
    const html = renderToStaticMarkup(
      <SessionPreparationPanel
        projection={projection({
          state: "unavailable",
          statusText: "Some equipment is unavailable.",
          rows: [
            row("confirmed-1", "available"),
            row("confirmed-2", "available"),
            row("confirmed-3", "available"),
            row("confirmed-4", "available"),
            row("confirmed-5", "available"),
            row("attention", "unavailable", {
              label: "Rack or stands",
              usageContext: "Used for Squat",
              minWeight: 300,
              requiresKnownGeometry: true,
            }),
          ],
        })}
        hasAcknowledgedWork={false}
        continueTargetId="workout-warmup"
      />,
    );

    expect(html).toContain("Before warm-up");
    expect(html).toContain("Prepare workout");
    expect(html).toContain('aria-label="Equipment needing attention"');
    expect(html).toContain('aria-label="Available equipment to prepare"');
    expect(html).toContain("Show all 5 available items");
    expect(html.indexOf("Rack or stands")).toBeLessThan(
      html.indexOf("Equipment confirmed-1"),
    );
    expect(html).not.toContain('role="checkbox"');
    expect(html).not.toContain("300");
    expect(html).toContain('href="#workout-warmup"');
    expect(html).toMatch(/class="[^"]*min-h-11[^"]*motion-reduce:transition-none[^"]*"[^>]*>Go to warm-up/);
  });

  it("distinguishes missing retained evidence from a no-equipment workout", () => {
    const unknown = renderToStaticMarkup(
      <SessionPreparationPanel
        projection={projection({
          state: "unknown",
          statusText: "Some equipment requirements are unknown.",
          evidenceState: "unknown",
        })}
        hasAcknowledgedWork={false}
        continueTargetId="workout-warmup"
      />,
    );
    const noneNeeded = renderToStaticMarkup(
      <SessionPreparationPanel
        projection={projection({ statusText: "No equipment needed." })}
        hasAcknowledgedWork={false}
        continueTargetId="workout-warmup"
      />,
    );

    expect(unknown).toContain("does not have a saved equipment list");
    expect(unknown).toContain("has not guessed from exercise names");
    expect(unknown).toContain("No saved equipment list is available");
    expect(unknown).not.toContain("Use the saved equipment list");
    expect(unknown).not.toContain(">0 items<");
    expect(unknown).toContain('data-testid="session-preparation-evidence-notice"');
    expect(noneNeeded).toContain("No equipment needed.");
    expect(noneNeeded).not.toContain("does not have a saved equipment list");
  });

  it("keeps attention visible after acknowledged work", () => {
    const html = renderToStaticMarkup(
      <SessionPreparationPanel
        projection={projection({
          state: "unknown",
          statusText: "Some equipment requirements are unknown.",
          evidenceState: "partial_unknown",
          rows: [row("unknown", "unknown")],
        })}
        hasAcknowledgedWork
        continueTargetId="workout-warmup"
        continueLabel="Review warm-up"
      />,
    );

    expect(html).toMatch(/^<section /);
    expect(html).toContain("Workout equipment");
    expect(html).toContain("Equipment update");
    expect(html).toContain("Equipment unknown");
    expect(html).toContain("Review warm-up");
    expect(html).toContain("Some exercises are missing saved equipment details");
    expect(html).toContain("1 item shown from saved requirements");
  });

  it("distinguishes saved-but-incompatible equipment from missing equipment", () => {
    const html = renderToStaticMarkup(
      <SessionPreparationPanel
        projection={projection({
          state: "unavailable",
          statusText: "Saved equipment is present, but no compatible setup covers this workout.",
          rows: [
            row("present-conflict", "incompatible"),
            row("missing", "unavailable", { statusText: "Unavailable in saved equipment" }),
          ],
        })}
        hasAcknowledgedWork={false}
        continueTargetId="workout-warmup"
      />,
    );

    expect(html).toContain("Saved equipment is present, but no compatible setup covers this workout.");
    expect(html).toContain("Review equipment that is missing or has no compatible saved setup.");
    expect(html).toContain('data-equipment-status="incompatible"');
    expect(html).toContain("No compatible saved setup");
    expect(html).toContain('data-equipment-status="unavailable"');
    expect(html).toContain("Unavailable in saved equipment");
  });

  it("withholds stale requirements while an exercise change is updating", () => {
    const html = renderToStaticMarkup(
      <SessionPreparationPanel
        projection={projection({
          state: "unknown",
          statusText: "Updating equipment after workout change.",
          evidenceState: "updating",
          rows: [],
        })}
        hasAcknowledgedWork
        continueTargetId="set-entry-next"
      />,
    );

    expect(html).toContain("Previous exercise requirements are withheld");
    expect(html).toContain("Wait for the updated exercise requirements");
    expect(html).not.toContain("Use the saved equipment list");
    expect(html).not.toContain(">0 items<");
    expect(html).toMatch(/^<section /);
  });

  it("collapses an all-confirmed post-acknowledgement list to a named native disclosure", () => {
    const html = renderToStaticMarkup(
      <SessionPreparationPanel
        projection={projection({ rows: [row("confirmed", "available")] })}
        hasAcknowledgedWork
        continueTargetId="workout-warmup"
      />,
    );

    expect(html).toMatch(/^<details /);
    expect(html).not.toMatch(/^<details [^>]*open/);
    expect(html).toContain("Workout equipment");
    expect(html).toContain("1 item · Equipment is available.");
    expect(html).toContain("Show details");
  });
});
