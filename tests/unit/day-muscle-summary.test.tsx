import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DayMuscleSummary } from "@/components/muscle-map/day-muscle-summary";
import { FroggyMuscleMap } from "@/components/muscle-map/froggy-muscle-map";
import { aggregateMuscleWork, type MuscleWork } from "@/lib/muscle-coverage";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { ProgramMuscleMap } from "@/components/muscle-map/program-muscle-map";
import type { ProgramPresentation } from "@/lib/program-presentation";

const row = (dayId: string, direct: string[], sets = 3): MuscleWork => ({
  dayId,
  dayName: dayId,
  dayIndex: 0,
  slotId: `slot-${dayId}`,
  exerciseId: "exercise",
  exerciseName: "Synthetic exercise",
  sets,
  direct,
  supporting: ["triceps"],
  catalogReviewed: true,
  missingPrimary: false,
  coverageReview: { version: "test", source: "test", note: "test" },
});
const work = [row("a", ["chest"]), row("b", ["lats"], 8)];

describe("compact workout-day muscle coverage", () => {
  it("shows only the requested saved day with fixed colours and an encoded deep link", () => {
    const html = renderToStaticMarkup(
      <DayMuscleSummary dayId="a" dayName="Push" work={work} />,
    );
    expect(html).toContain("/program/muscles?day=a");
    expect(html).toContain("Chest: 3 direct sets");
    expect(html).toMatch(
      /data-muscle="chest" data-direct-sets="3"[^>]*fill="#fa7879"/,
    );
    expect(html).toMatch(/data-muscle="lats" data-direct-sets="0"/);
    expect(html).toMatch(/data-muscle="triceps" data-direct-sets="0"/);
    expect(html).not.toContain("data-set-number");
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain("<rect");
    expect(html).toContain("<clipPath");
  });
  it("recalculates changed prescriptions and exercise targets without retaining old highlights", () => {
    const html = renderToStaticMarkup(
      <DayMuscleSummary
        dayId="a"
        dayName="Renamed"
        work={[row("a", ["quads"], 7)]}
      />,
    );
    expect(html).toContain("Quadriceps: 7 direct sets");
    expect(html).toMatch(
      /data-muscle="quads" data-direct-sets="7"[^>]*fill="#d62940"/,
    );
    expect(html).toMatch(/data-muscle="chest" data-direct-sets="0"/);
  });
  it("discloses text-only coverage and missing prescriptions without invented highlights", () => {
    const html = renderToStaticMarkup(
      <DayMuscleSummary
        dayId="a"
        dayName="Core"
        work={[{ ...row("a", ["deepabs"]), sets: null }]}
      />,
    );
    expect(html).toContain("No mapped direct sets");
    expect(html).toContain("Mapping details and limitations available");
    expect(html).not.toContain('data-direct-sets="3"');
  });
  it("omits days without exercises rather than implying zero training", () => {
    expect(
      renderToStaticMarkup(
        <DayMuscleSummary dayId="rest" dayName="Rest" work={work} />,
      ),
    ).toBe("");
  });
  it("preserves full-map artwork, labels, and counts", () => {
    const html = renderToStaticMarkup(
      <FroggyMuscleMap coverage={aggregateMuscleWork(work)} />,
    );
    expect(html).not.toContain("<rect");
    expect(html).toContain('data-set-number="chest"');
    expect(html).toContain('aria-label="Back muscle map"');
    expect(html).not.toContain("<figcaption>");
  });
  it("starts the full map on the requested day while ordinary navigation shows all", () => {
    const program = {
      program: { id: "p", name: "Synthetic" },
      version: { id: "v", versionNo: 1 },
      days: ["a", "b"].map((id) => ({
        id,
        lineageId: id,
        name: id,
        slots: [],
      })),
    } as unknown as ProgramPresentation;
    const html = renderToStaticMarkup(
      <ProgramMuscleMap program={program} initialDayId="b" />,
    );
    expect(html).toContain('href="/program?day=b"');
    expect(html).toContain("Back to Day 2");
    expect(html).toMatch(/aria-pressed="false"[^>]*>All days/);
    expect(html).toMatch(/aria-pressed="false" title="Day 1 — a"/);
    expect(html).toMatch(/aria-pressed="true" title="Day 2 — b"/);
    const all = renderToStaticMarkup(<ProgramMuscleMap program={program} />);
    expect(all).toContain('href="/program"');
    expect(all).toContain("Back to Program");
    expect(all).toMatch(/aria-pressed="true"[^>]*>All days/);
    const stale = renderToStaticMarkup(
      <ProgramMuscleMap program={program} initialDayId="removed" />,
    );
    expect(stale).toContain('href="/program"');
    expect(stale).not.toContain('/program?day=removed');
  });
});
