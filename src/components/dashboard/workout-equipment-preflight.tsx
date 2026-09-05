import Link from "next/link";
import { AlertTriangle, ChevronRight } from "lucide-react";
import type { SessionPreparationEquipmentProjection } from "@/lib/session-equipment-requirements";
import { equipmentManagementHref } from "@/lib/equipment-management-navigation";

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
    <section
      aria-label={headline}
      data-testid="workout-equipment-preflight"
      className="flex min-h-11 flex-col gap-2 rounded-xl border border-amber-500/50 bg-amber-500/5 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
      <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-amber-700 dark:text-amber-400" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug">{headline}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">
          {projection.statusText} Review before Start if needed; this does not
          block the workout.
        </span>
      </span>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {attentionRows.map((row) => (
          <Link
            key={row.key}
            href={equipmentManagementHref({ equipmentType: row.equipmentType, equipmentDefinitionId: row.equipmentDefinitionId, returnTo: "/today" })}
            className="flex min-h-11 items-center justify-between gap-2 rounded-lg border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>
              <span className="block text-sm font-medium">{row.label}</span>
              <span className="block text-xs text-muted-foreground">{row.statusText}</span>
              {row.usageContext && <span className="block text-xs text-muted-foreground">{row.usageContext}</span>}
            </span>
            <ChevronRight className="size-4 shrink-0" />
          </Link>
        ))}
        {attentionRows.length === 0 && <Link href="/settings/equipment" className="inline-flex min-h-11 items-center underline">Review saved equipment</Link>}
      </div>
    </section>
  );
}
