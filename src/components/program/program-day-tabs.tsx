"use client";

import Link from "next/link";
import { useEffect, useRef, type MouseEvent } from "react";
import { formatProgramDayLabel } from "@/lib/program-presentation";
import { cn } from "@/lib/utils";

const programDayHistoryMarker = "__workoutTrackerProgramDay";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createProgramDayHistoryState(href: string) {
  const current = window.history.state;
  if (!isRecord(current) || current.__NA !== true) return null;

  const state: Record<string, unknown> = {
    ...current,
    [programDayHistoryMarker]: true,
  };
  const routerState = current.__PRIVATE_NEXTJS_INTERNALS_TREE;
  if (isRecord(routerState)) {
    state.__PRIVATE_NEXTJS_INTERNALS_TREE = {
      ...routerState,
      renderedSearch: new URL(href, window.location.href).search,
    };
  }
  return state;
}

function ownsProgramDayHistoryEntry(value: unknown) {
  return (
    isRecord(value) &&
    value[programDayHistoryMarker] === true
  );
}

export function ProgramDayTabs({
  days,
  activeId,
  pathname,
  label,
  onSelect,
  compact = false,
}: {
  days: Array<{ lineageId: string; name: string }>;
  activeId: string;
  pathname: "/program" | "/program/edit";
  label: string;
  onSelect?: (lineageId: string) => void;
  compact?: boolean;
}) {
  const ownsHistory = pathname === "/program";
  const refs = useRef<Array<HTMLAnchorElement | null>>([]);
  useEffect(() => {
    if (!onSelect) return;

    if (ownsHistory) {
      const state = createProgramDayHistoryState(window.location.href);
      if (state) {
        // Keep Next's router metadata on the initial entry so cross-route
        // Back/Forward remains an in-document framework navigation.
        window.history.replaceState(state, "", window.location.href);
      }
    }

    const syncFromHistory = (event: PopStateEvent) => {
      if (window.location.pathname !== pathname) return;
      if (ownsHistory && !ownsProgramDayHistoryEntry(event.state)) return;

      if (ownsHistory) {
        // These marked same-page entries are owned by this already-loaded
        // complete view. Stop Next's restore before it requests another RSC
        // payload. Unmarked and cross-route entries remain framework-owned.
        event.stopImmediatePropagation();
      }
      const requested = new URLSearchParams(window.location.search).get("day");
      const selected =
        days.find((day) => day.lineageId === requested) ?? days[0];
      if (selected) onSelect(selected.lineageId);
    };
    window.addEventListener("popstate", syncFromHistory, {
      capture: ownsHistory,
    });
    return () => {
      window.removeEventListener("popstate", syncFromHistory, {
        capture: ownsHistory,
      });
    };
  }, [days, onSelect, ownsHistory, pathname]);

  return (
    <nav aria-label={label} className="overflow-x-auto pb-1">
      <div role="tablist" aria-label={label} aria-orientation="horizontal" className="flex min-w-max gap-2">
        {days.map((day, index) => {
          const href = `${pathname}?day=${encodeURIComponent(day.lineageId)}`;
          return (
            <Link
            key={day.lineageId}
            ref={(node) => { refs.current[index] = node; }}
            role="tab"
            aria-selected={activeId === day.lineageId}
            tabIndex={activeId === day.lineageId ? 0 : -1}
            className={cn(
              "min-h-11 rounded-lg border px-4 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
              activeId === day.lineageId ? "border-primary bg-primary text-primary-foreground" : "bg-card",
            )}
            href={href}
            prefetch={false}
            scroll={false}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (
                !onSelect ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              onSelect(day.lineageId);
              if (ownsHistory) {
                const state = createProgramDayHistoryState(href);
                if (state) {
                  // A saved Program view already owns every day. Preserve the
                  // framework state while adding a marked, search-correct
                  // entry without dispatching a duplicate server restore.
                  window.history.pushState(state, "", href);
                  return;
                }
              }
              // Editing remains framework-owned so refresh and publish always
              // use the router's current canonical day.
              window.history.pushState(null, "", href);
            }}
            onKeyDown={(event) => {
              let target = index;
              if (event.key === "ArrowRight") target = (index + 1) % days.length;
              else if (event.key === "ArrowLeft") target = (index - 1 + days.length) % days.length;
              else if (event.key === "Home") target = 0;
              else if (event.key === "End") target = days.length - 1;
              else return;
              event.preventDefault();
              refs.current[target]?.focus();
            }}
          >
            {compact ? (
              <>Day {index + 1}</>
            ) : (
              <>
                <span className="sm:hidden">Day {index + 1}</span>
                <span className="hidden sm:inline">
                  {formatProgramDayLabel(day.name, index)}
                </span>
              </>
            )}
          </Link>
          );
        })}
      </div>
    </nav>
  );
}
