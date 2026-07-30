import { Flame, Trophy } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { DashboardStats } from "@/services/dashboard";
import { cn } from "@/lib/utils";

const BAR_MAX_PX = 48;

export function TodayStats({
  stats,
  unit,
}: {
  stats: DashboardStats;
  unit: string;
}) {
  const max = Math.max(1, ...stats.weeklyVolume.map((p) => p.volume));

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <p className="text-2xl font-semibold leading-none tabular-nums">
                {stats.workoutsThisWeek}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                workout{stats.workoutsThisWeek === 1 ? "" : "s"} this week
              </p>
            </div>
            <div className="h-9 w-px bg-border" />
            <div className="flex items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <Flame className="size-5" />
              </span>
              <div>
                <p className="text-2xl font-semibold leading-none tabular-nums">
                  {stats.streakWeeks}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  week streak
                </p>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Volume · last 8 weeks
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {stats.totalVolumeThisWeek.toLocaleString()} {unit} this week
              </span>
            </div>
            <div className="flex h-12 items-end gap-1">
              {stats.weeklyVolume.map((p, i) => {
                const newest = i === stats.weeklyVolume.length - 1;
                const height = Math.max(
                  3,
                  Math.round((p.volume / max) * BAR_MAX_PX)
                );
                const week = new Date(p.weekStartISO).toLocaleDateString(
                  undefined,
                  { timeZone: "UTC", month: "short", day: "numeric" }
                );
                return (
                  <div
                    key={p.weekStartISO}
                    className={cn(
                      "flex-1 rounded-t-sm transition-colors",
                      newest ? "bg-primary" : "bg-primary/25"
                    )}
                    style={{ height }}
                    title={`Week of ${week}: ${p.volume.toLocaleString()} ${unit}`}
                  />
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {stats.recentPRs.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Trophy className="size-4 text-success" />
              New personal record{stats.recentPRs.length > 1 ? "s" : ""}
            </div>
            <ul className="flex flex-col gap-1.5">
              {stats.recentPRs.map((pr) => (
                <li
                  key={pr.exercise}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="truncate">{pr.exercise}</span>
                  <span className="shrink-0 rounded-md bg-success/10 px-2 py-0.5 font-medium tabular-nums text-success">
                    {pr.weight}×{pr.reps} {unit}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
