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
          <Link href="/program" className={styles.back}>
            ← Program
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
                                  ? " · catalog not reviewed"
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
                  <p className={styles.notice}>
                    No{" "}
                    {filter === "supporting"
                      ? "supporting"
                      : filter === "all"
                        ? "direct or supporting"
                        : "direct"}{" "}
                    work is mapped here. Missing mappings can leave work
                    unrepresented.
                  </p>
                )}
              </>
            ) : (
              <div className={styles.empty}>
                <h2>Your Program, on Froggy</h2>
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
              <p>
                Numbers and red shading show planned direct sets across the
                selected days. A 6 means six sets, not six exercises or an
                activation score. Each paired region has one number; it is not a
                separate count for each side.
              </p>
              <p>
                Reviewed exercise variants use a versioned target/supporting
                classification with reference notes. Other exercises retain
                their saved catalog mappings, flagged below. Supporting sets
                stay separate and never add to the red number. One set can
                target several muscles, so muscle totals should not be added
                together as a Program set total.
              </p>
              <p>
                Warm-ups are excluded. Each slot’s prescription is counted once,
                including timed or unilateral work; sets are not doubled by
                side. Days mean distinct Program days, not necessarily workouts
                per week. This is planned coverage, not measured activation,
                effectiveness or proof of adequate training.
              </p>
              <p>
                This is a schematic training map with 23 surface regions, not an
                anatomical atlas. Forearm compartments, delt regions, obliques
                and side glutes are distinct. Chest, quadriceps, hamstrings and
                calves remain grouped; deep muscles have text details.
                Boundaries approximate the stylized body. Zero means no mapped
                direct sets, not no involvement. The classifications are an
                interpretation of exercise references, not measured activation
                or anatomical certification.
              </p>
              {issues.length > 0 && (
                <ul>
                  {issues.map((row) => (
                    <li key={`${row.dayId}-${row.slotId}`}>
                      {row.exerciseName}:{" "}
                      {[
                        row.missingPrimary && "no primary mapping",
                        !row.catalogReviewed && "catalog not reviewed",
                        !row.coverageReview &&
                          "coverage roles not reviewed; saved catalog mapping used",
                        row.sets === null &&
                          "working-set prescription missing or invalid",
                        ...[...row.direct, ...row.supporting]
                          .filter((k) => !hasMuscleArtwork(k))
                          .map((k) => `${muscleLabel(k)} has no artwork`),
                      ]
                        .filter(Boolean)
                        .join("; ")}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </div>
        </section>
      </div>
    </main>
  );
}
