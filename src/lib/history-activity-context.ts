import type { ActivityReport } from "@/services/activity-report";

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function formatIndependentActivityContext(report: ActivityReport) {
  if (report.overview.totalActivities === 0) {
    return "No independent activities were recorded in this period.";
  }
  const summary = `${report.overview.totalActivities} independent ${report.overview.totalActivities === 1 ? "activity" : "activities"} · ${number.format(report.overview.totalMinutes)} min.`;
  const trend = report.trend.minuteChangePercent;
  if (trend == null) {
    return `${summary} No comparable four-week duration trend is available.`;
  }
  if (trend === 0) {
    return `${summary} Latest four-week duration is unchanged from the prior four weeks.`;
  }
  return `${summary} Latest four-week duration is ${Math.abs(trend)}% ${trend > 0 ? "higher" : "lower"} than the prior four weeks.`;
}
