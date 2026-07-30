import Link from "next/link";
import {
  buildHistoryHref,
  type HistoryContext,
} from "@/lib/history-navigation";
import { cn } from "@/lib/utils";

type RangeOption = {
  key: string;
  label: string;
};

export function HistoryRangeNav({
  options,
  currentRange,
  context,
}: {
  options: readonly RangeOption[];
  currentRange: string;
  context: HistoryContext;
}) {
  return (
    <nav
      aria-label="History time period"
      className="grid w-full grid-cols-2 gap-1 rounded-xl border bg-card p-1 min-[22rem]:grid-cols-3 sm:w-auto sm:grid-cols-5"
    >
      {options.map((option) => (
        <Link
          key={option.key}
          href={buildHistoryHref({ ...context, range: option.key })}
          scroll={false}
          prefetch={false}
          aria-current={currentRange === option.key ? "page" : undefined}
          className={cn(
            "flex min-h-10 items-center justify-center rounded-lg px-2 py-2 text-center text-xs font-medium leading-tight transition-colors sm:px-3",
            currentRange === option.key
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
