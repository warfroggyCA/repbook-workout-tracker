"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProgramPresentation } from "@/lib/program-presentation";
import {
  formatCompactProgramDayLabel,
  formatProgramDayLabel,
} from "@/lib/program-presentation";
import {
  aggregateMuscleWork,
  DIRECT_SET_SCALE,
  hasMuscleArtwork,
  MUSCLE_KEYS,
  muscleLabel,
  programMuscleWork,
} from "@/lib/muscle-coverage";
import { FroggyMuscleMap } from "./froggy-muscle-map";
import styles from "./muscle-map.module.css";

type Filter = "all" | "direct" | "supporting" | "days";

export function ProgramMuscleMap({
  program,
  initialDayId = null,
  unavailableDay = false,
}: {
  program: ProgramPresentation;
  initialDayId?: string | null;
  unavailableDay?: boolean;
}) {
  const router = useRouter();
  const detailScroll = useRef<HTMLDivElement>(null);
  const [refreshing, startRefresh] = useTransition();
  const [daySelection, setDaySelection] = useState<Set<string> | null>(() =>
    initialDayId ? new Set([initialDayId]) : null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const work = useMemo(() => programMuscleWork(program), [program]);
  const all = useMemo(() => aggregateMuscleWork(work), [work]);
  const days = useMemo(
    () =>
      new Set(
        program.days
          .filter((d) => daySelection === null || daySelection.has(d.lineageId))
          .map((d) => d.lineageId),
      ),
    [program.days, daySelection],
  );
  const coverage = useMemo(() => aggregateMuscleWork(work, days), [work, days]);
  const keys = [
    ...MUSCLE_KEYS,
    ...Object.keys(all)
      .filter((k) => !MUSCLE_KEYS.some((known) => known === k))
      .sort(),
  ];
  const detail = all[focused] ?? {
    direct: 0,
    supporting: 0,
    directDays: 0,
    rows: [],
  };
  const rows = detail.rows.filter(
    (row) =>
      filter === "all" ||
      (filter === "supporting"
        ? row.supporting.includes(focused)
        : row.direct.includes(focused)),
  );
  const issues = work.filter(
    (row) =>
      row.missingPrimary ||
      !row.catalogReviewed ||
      !row.coverageReview ||
      row.sets === null ||
      [...row.direct, ...row.supporting].some((k) => !hasMuscleArtwork(k)),
  );
  const allDays = program.days.length > 0 && days.size === program.days.length;
  const returnDayIndex = program.days.findIndex(
    (day) => day.lineageId === initialDayId,
  );
  const returnDay = program.days[returnDayIndex];

  useEffect(() => {
    if (detailScroll.current) detailScroll.current.scrollTop = 0;
  }, [focused]);

  function refresh() {
    startRefresh(() => router.refresh());
  }
  useEffect(() => {
    // Saved changes in another tab are read when this screen is revisited.
    const update = () => {
      if (document.visibilityState === "visible")
        startRefresh(() => router.refresh());
    };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [router]);
  function inspect(key: string) {
    setFocused(key);
    setFilter("all");
  }
  function toggleMuscle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
      if (focused === key) inspect([...next].at(-1) ?? "");
    } else {
      next.add(key);
      inspect(key);
    }
    setSelected(next);
  }
  function toggleDay(id: string) {
    const next = new Set(days);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDaySelection(next);
  }
  function toggleFilter(value: Filter) {
    setFilter(filter === value ? "all" : value);
  }

  return (
    <main className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <Link
            href={returnDay
              ? { pathname: "/program", query: { day: returnDay.lineageId } }
              : "/program"}
            className={styles.back}
            title={returnDay ? formatProgramDayLabel(returnDay.name, returnDayIndex) : undefined}
          >
            <span aria-hidden="true">←</span>
            {returnDay
              ? `Back to Day ${returnDayIndex + 1}`
              : "Back to Program"}
          </Link>
          <h1>Muscle coverage</h1>
          <p title={program.program.name}>{program.program.name}</p>
        </div>
        <div className={styles.actions}>
          <button onClick={refresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            onClick={() => {
              setDaySelection(new Set());
              setSelected(new Set());
              inspect("");
            }}
          >
            Clear all
          </button>
        </div>
      </header>
      {unavailableDay && (
        <p role="status" className="text-sm text-muted-foreground">
          That workout day is no longer in the active Program. Showing all
          current days.
        </p>
      )}
      <nav className={styles.days} aria-label="Days shown on the muscle map">
        <button
          aria-pressed={allDays}
          onClick={() => setDaySelection(allDays ? new Set() : null)}
        >
          All days
        </button>
        {program.days.map((day, index) => (
          <button
            key={day.lineageId}
            aria-pressed={days.has(day.lineageId)}
            title={formatProgramDayLabel(day.name, index)}
            onClick={() => toggleDay(day.lineageId)}
          >
            {formatCompactProgramDayLabel(day.name, index)}
          </button>
        ))}
      </nav>
      <div className={styles.content}>
        <section
          className={styles.mapPanel}
          aria-label="Program muscle coverage artwork"
        >
          <p className={styles.mapStatus} aria-live="polite">
            {days.size
              ? `${days.size} of ${program.days.length} days shown`
              : "No days shown · tap a muscle to explore"}
          </p>
          <FroggyMuscleMap
            coverage={coverage}
            selected={selected}
            onToggle={toggleMuscle}
          />
          <div className={styles.legend}>
            <span>Numbers + red = direct sets</span>
            {DIRECT_SET_SCALE.map((b) => (
              <span key={b.label}>
                <i style={{ backgroundColor: b.color }} />
                {b.label}
              </span>
            ))}
          </div>
        </section>
        <section className={styles.details} aria-label="Muscle details">
          <div className={styles.picker}>
            <label htmlFor="muscle-picker">Explore a muscle</label>
            <div>
              <select
                id="muscle-picker"
                value={focused}
                onChange={(e) => inspect(e.target.value)}
              >
                <option value="">Choose a muscle…</option>
                {keys.map((key) => (
                  <option key={key} value={key}>
                    {muscleLabel(key)}
                    {hasMuscleArtwork(key) ? "" : " · no artwork"}
                  </option>
                ))}
              </select>
              <button
                disabled={!focused}
                aria-pressed={!!focused && selected.has(focused)}
                onClick={() => toggleMuscle(focused)}
              >
                {selected.has(focused) ? "Deselect" : "Select"}
              </button>
            </div>
          </div>
          <div className={styles.selections} aria-label="Selected muscles">
            {selected.size ? (
              [...selected].map((key) => (
                <button
                  key={key}
                  aria-pressed={focused === key}
                  onClick={() => inspect(key)}
                >
                  {muscleLabel(key)}
                </button>
              ))
            ) : (
              <span>No muscles selected · select several to compare</span>
            )}
          </div>
          <div
            ref={detailScroll}
            className={styles.detailScroll}
            tabIndex={0}
            aria-label="Scrollable muscle information"
          >
            {focused ? (
              <>
                <h2>{muscleLabel(focused)}</h2>
                <p className={styles.muted}>
                  Across the full saved Program, regardless of days shown.
                </p>
                <div
                  className={styles.metrics}
                  aria-label="Filter muscle exercise details"
                >
                  <button
                    aria-pressed={filter === "direct"}
                    onClick={() => toggleFilter("direct")}
                  >
                    <strong>{detail.direct}</strong>
                    <span>Direct sets</span>
                  </button>
                  <button
                    aria-pressed={filter === "supporting"}
                    onClick={() => toggleFilter("supporting")}
                  >
                    <strong>{detail.supporting}</strong>
                    <span>Supporting sets</span>
                  </button>
                  <button
                    aria-pressed={filter === "days"}
                    onClick={() => toggleFilter("days")}
                  >
                    <strong>{detail.directDays}</strong>
                    <span>Days with direct work</span>
                  </button>
                </div>
                <div className={styles.resultHeader}>
                  <h3>
                    {filter === "all"
                      ? "Where it appears"
                      : filter === "days"
                        ? "Direct work by day"
                        : `${filter === "direct" ? "Direct" : "Supporting"} work`}
                  </h3>
                  {filter !== "all" && (
                    <button onClick={() => setFilter("all")}>Show all</button>
                  )}
                </div>
                {!hasMuscleArtwork(focused) && (
                  <p className={styles.notice}>
                    This is a deep muscle group or a broad label without a
                    precise surface region. Its sets remain available here; the
                    illustration does not guess a location.
                  </p>
                )}
                {rows.length ? (
                  program.days.map((day, index) => {
                    const dayRows = rows.filter(
                      (r) => r.dayId === day.lineageId,
                    );
                    if (!dayRows.length) return null;
                    return (
                      <section key={day.lineageId} className={styles.dayDetail}>
                        <h4>
                          <Link
                            href={`/program?day=${encodeURIComponent(day.lineageId)}`}
                          >
                            {formatProgramDayLabel(day.name, index)}
                          </Link>
                        </h4>
                        {dayRows.map((row) => (
                          <div key={row.slotId} className={styles.exercise}>
                            <div>
                              {row.exerciseName}
                              <small>
                                {row.direct.includes(focused)
                                  ? "Direct target"
                                  : "Supporting role"}
                                {row.coverageReview
                                  ? " · reviewed coverage"
                                  : " · catalog mapping only"}
                                {!row.catalogReviewed
                                  ? " · exercise details need review"
                                  : ""}
                              </small>
                              {row.coverageReview && (
                                <details className={styles.mappingNote}>
                                  <summary>Why this mapping?</summary>
                                  <p>{row.coverageReview.note}</p>
                                  <a
                                    href={row.coverageReview.source}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Exercise reference ↗
                                  </a>
                                </details>
                              )}
                            </div>
                            <b>
                              {row.sets === null
                                ? "Sets unknown"
                                : `${row.sets} sets`}
                            </b>
                          </div>
                        ))}
                      </section>
                    );
                  })
                ) : (
                  <div className={styles.notice}>
                    <p>
                      {filter === "all"
                        ? `No exercises in this Program currently list ${muscleLabel(focused)} as a main or helping muscle. This doesn’t necessarily mean it does no work.`
                        : filter === "supporting"
                          ? `No exercises in this Program list ${muscleLabel(focused)} in a helping role.`
                          : `No exercises in this Program list ${muscleLabel(focused)} as the main target.`}
                    </p>
                    {(filter === "direct" || filter === "days") &&
                      detail.rows.some((row) => row.supporting.includes(focused)) && (
                        <>
                          <p>This muscle helps with other exercises in your Program.</p>
                          <button onClick={() => setFilter("supporting")}>
                            View supporting exercises
                          </button>
                        </>
                      )}
                    {filter === "supporting" &&
                      detail.rows.some((row) => row.direct.includes(focused)) && (
                        <button onClick={() => setFilter("direct")}>
                          View main-target exercises
                        </button>
                      )}
                  </div>
                )}
              </>
            ) : (
              <div className={styles.empty}>
                <h2>Your muscle coverage</h2>
                <p>
                  Tap muscles on either view, or choose one above. Selections
                  add together; tap again to remove.
                </p>
                <p>
                  Day buttons change the shading and numbers. Muscle details
                  always look across your full Program.
                </p>
              </div>
            )}
            <details className={styles.explanation}>
              <summary>
                How to read this map
                {issues.length
                  ? ` · ${issues.length} exercises with limitations`
                  : ""}
              </summary>
              <ul>
                <li><strong>Red shows your planned sets.</strong> Darker red means
                  more sets for that muscle. Warm-ups don’t count.</li>
                <li><strong>Tap days to compare them.</strong> Tap a muscle to see
                  its exercises across your whole Program.</li>
                <li><strong>Helping muscles are listed separately.</strong> Their
                  sets don’t add to the red number. No red doesn’t mean a muscle
                  does no work.</li>
              </ul>
              <p>
                This map is a simple guide. Some muscles are grouped together or
                listed only in the details. The colours don’t measure how hard
                you trained or whether you’ve done enough.
              </p>
              {issues.length > 0 && (
                <details>
                  <summary>Exercise notes ({issues.length})</summary>
                  <ul>
                  {issues.map((row) => (
                    <li key={`${row.dayId}-${row.slotId}`}>
                      {row.exerciseName}:{" "}
                      {[
                        row.missingPrimary && "main muscle not recorded",
                        !row.catalogReviewed && "exercise details need review",
                        !row.coverageReview &&
                          "using saved muscle labels; not yet checked for this variation",
                        row.sets === null &&
                          "set count missing or unclear",
                        ...[...row.direct, ...row.supporting]
                          .filter((k) => !hasMuscleArtwork(k))
                          .map((k) => `${muscleLabel(k)} is listed in details only`),
                      ]
                        .filter(Boolean)
                        .join("; ")}
                    </li>
                  ))}
                  </ul>
                </details>
              )}
            </details>
          </div>
        </section>
      </div>
    </main>
  );
}
