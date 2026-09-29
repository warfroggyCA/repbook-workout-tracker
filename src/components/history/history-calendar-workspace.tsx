import { HistoryCalendar } from "@/components/history/history-calendar";
import {
  type HistoryCalendarView,
  type HistoryContext,
} from "@/lib/history-navigation";
import type {
  HistoryCalendarRecord,
  HistoryRangeKey,
  HistoryReport,
} from "@/services/history-report";
import type { HistoryLens } from "@/services/history-lenses";

const tonePriority = { watch: 0, positive: 1, neutral: 2 } as const;

export function selectHistoryActionSignal(
  lenses: readonly HistoryLens[],
): HistoryLens | null {
  return (
    lenses
      .map((lens, index) => ({ lens, index }))
      .filter(({ lens }) => lens.decision.supported)
      .sort(
        (a, b) =>
          tonePriority[a.lens.tone] - tonePriority[b.lens.tone] ||
          a.index - b.index,
      )[0]?.lens ?? null
  );
}

export function HistoryCalendarWorkspace({
  records,
  context,
  calendarDate,
  ownerToday,
  unit,
}: {
  report: HistoryReport;
  records: HistoryCalendarRecord[];
  context: HistoryContext & {
    range: HistoryRangeKey;
    calendarView: HistoryCalendarView;
  };
  calendarDate: string | null;
  ownerToday: string;
  unit: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <HistoryCalendar
        key={`${context.calendarView}-${calendarDate ?? ownerToday}`}
        records={records}
        unit={unit}
        range={context.range}
        initialView={context.calendarView}
        initialDate={calendarDate}
        ownerToday={ownerToday}
      />
    </div>
  );
}
