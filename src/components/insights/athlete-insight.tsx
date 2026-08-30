import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AthleteInsightCandidate } from "@/lib/athlete-insights";
import { cn } from "@/lib/utils";

function unitLabel(unit: AthleteInsightCandidate["evidence"]["unit"]) {
  if (unit === "lb" || unit === "kg") return `Recorded load unit: ${unit}`;
  if (unit === "reps") return "Compared in repetitions";
  if (unit === "seconds") return "Compared in seconds";
  return null;
}

export function AthleteInsightEvidence({
  insight,
}: {
  insight: AthleteInsightCandidate;
}) {
  const unit = unitLabel(insight.evidence.unit);
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        How calculated
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </summary>
      <div className="space-y-1 pb-2 leading-relaxed">
        <p>{insight.evidence.comparisonWindow}.</p>
        <p>
          {insight.evidence.sourceRecordIds.length} named source {insight.evidence.sourceRecordIds.length === 1 ? "record" : "records"}
          {insight.evidence.exactExerciseId != null
            ? " · exact exercise variant only"
            : ""}
          {unit ? ` · ${unit}` : ""}.
        </p>
        {insight.evidence.limitations.length > 0 && (
          <ul className="list-disc space-y-1 pl-4">
            {insight.evidence.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

export function AthleteInsight({
  insight,
  onAction,
  className,
  compact = false,
}: {
  insight: AthleteInsightCandidate;
  onAction?: () => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <section
      data-testid={`athlete-insight-${insight.placement}`}
      data-insight-kind={insight.kind}
      data-ui-surface={compact ? undefined : "inset"}
      className={cn(
        compact ? "border-t py-2" : "ui-surface px-3 py-2.5",
        className,
      )}
      aria-label="Training insight"
    >
      <p className={cn("ui-metadata", compact && "sr-only")}>
        Training evidence
      </p>
      <p className="mt-1 text-sm font-semibold leading-snug" data-ui-essential="true">
        {insight.headline}
      </p>
      {insight.detail && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {insight.detail}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3">
        {insight.action && onAction && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto min-h-11 px-0 text-xs"
            onClick={onAction}
          >
            {insight.action.label}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Button>
        )}
        {insight.action && !onAction && (
          <Link
            href={insight.action.href}
            className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            {insight.action.label}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        )}
        <AthleteInsightEvidence insight={insight} />
      </div>
    </section>
  );
}
