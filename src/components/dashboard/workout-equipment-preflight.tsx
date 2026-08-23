import Link from "next/link";
import { AlertTriangle, ChevronRight } from "lucide-react";
import type { SessionPreparationEquipmentProjection } from "@/lib/session-equipment-requirements";

export function WorkoutEquipmentPreflight({
  projection,
}: {
  projection: SessionPreparationEquipmentProjection | null;
}) {
  if (projection == null) return null;
  const attentionRows = projection.rows.filter(
    (row) => row.classification === "attention",
  );
  if (projection.state === "available" && attentionRows.length === 0) {
    return null;
  }

  const headline = projection.state === "unknown"
    ? "Equipment check unavailable"
    : `${attentionRows.length} equipment item${
        attentionRows.length === 1 ? " needs" : "s need"
      } attention`;

  return (
    <Link
      href="/settings/equipment"
      aria-label={`${headline}. Review saved equipment before starting.`}
      data-testid="workout-equipment-preflight"
      className="flex min-h-11 items-center gap-3 rounded-xl border border-amber-500/50 bg-amber-500/5 px-3 py-2.5 outline-none hover:bg-amber-500/10 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <AlertTriangle className="size-4 shrink-0 text-amber-700 dark:text-amber-400" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug">{headline}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">
          {projection.statusText} Review before Start if needed; this does not
          block the workout.
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
