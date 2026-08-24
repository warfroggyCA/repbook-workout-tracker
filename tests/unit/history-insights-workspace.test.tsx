import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistoryInsightsWorkspace } from "@/components/history/history-insights-workspace";
import { summarizeActivities } from "@/services/activity-report";
import { historyRangeStart, summarizeHistory } from "@/services/history-report";

const now = new Date("2026-08-23T12:00:00.000Z");

function emptyReports() {
  const since = historyRangeStart("4w", now);
  const report = summarizeHistory([], [], 3, since, now);
  const activityReport = summarizeActivities([], since, now);

  return { report, activityReport };
}

function renderOverview({
  report,
  activityReport,
} = emptyReports()) {

  return renderToStaticMarkup(
    <HistoryInsightsWorkspace
      report={report}
      activityReport={activityReport}
      lens="overview"
      context={{ range: "4w", view: "insights", lens: "overview" }}
      rangeLabel="4 weeks"
      unit="lb"
    />,
  );
}

describe("HistoryInsightsWorkspace overview", () => {
  it("presents a concise narrative, exhibits, and direct evidence actions", () => {
    const html = renderOverview();

    expect(html).toContain("Current progress");
    expect(html).toContain("At a glance");
    expect(html).toContain("Explore the evidence");
    expect(html).toContain("Open progress evidence");
    expect(html).toContain("View exact exercises");
    expect(html).not.toContain("Strength overview");
    expect(html).not.toContain("Five questions");
  });

  it("shows unavailable evidence explicitly instead of presenting it as zero", () => {
    const html = renderOverview();

    expect(html).toContain("Not available");
    expect(html).toContain("No eligible loaded sets");
    expect(html).toContain(
      "No completed workout data is available for a weekly chart.",
    );
    expect(html).toContain(
      "No retained planned-outcome evidence is available for this period.",
    );
    expect(html).toContain(
      "No independent activities were recorded in this period.",
    );
    expect(html).not.toContain("0 lb");
  });

  it("preserves a recorded zero loaded volume", () => {
    const { report, activityReport } = emptyReports();
    const html = renderOverview({
      activityReport,
      report: {
        ...report,
        overview: {
          ...report.overview,
          loadedSets: 1,
          loadedVolume: 0,
        },
      },
    });

    expect(html).toContain("0 lb");
    expect(html).toContain("Eligible loaded sets only");
    expect(html).not.toContain("No eligible loaded sets");
  });

  it("keeps unknown and incomplete planned outcomes distinct from zero", () => {
    const { report, activityReport } = emptyReports();
    const html = renderOverview({
      activityReport,
      report: {
        ...report,
        overview: {
          ...report.overview,
          targetOutcomes: {
            ...report.overview.targetOutcomes,
            below: 0,
            at: 1,
            above: 0,
            unknown: 2,
            supported: 1,
            atOrAboveRate: 100,
          },
          targetDenominatorComplete: false,
        },
      },
    });

    expect(html).toContain("Unknown");
    expect(html).toContain(">2</dd>");
    expect(html).toContain(
      "The retained denominator is incomplete, so no overall conclusion is supported.",
    );
  });
});
