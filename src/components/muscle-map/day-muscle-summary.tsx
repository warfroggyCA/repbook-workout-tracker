import Link from "next/link";
import {
  aggregateMuscleWork,
  hasMuscleArtwork,
  muscleLabel,
  type MuscleWork,
} from "@/lib/muscle-coverage";
import { FroggyMuscleMap } from "./froggy-muscle-map";
import styles from "./muscle-map.module.css";

/** A read-only miniature of the full map, using the same fixed planned-set scale. */
export function DayMuscleSummary({
  dayId,
  dayName,
  work,
}: {
  dayId: string;
  dayName: string;
  work: MuscleWork[];
}) {
  const rows = work.filter((row) => row.dayId === dayId);
  if (!dayId || rows.length === 0) return null;
  const coverage = aggregateMuscleWork(rows);
  const targets = Object.entries(coverage).filter(
    ([, value]) => value.direct > 0,
  );
  const label = targets.length
    ? targets
        .map(
          ([key, value]) => `${muscleLabel(key)}: ${value.direct} direct sets`,
        )
        .join(", ")
    : "No mapped direct sets";
  const incomplete = rows.some(
    (row) =>
      row.missingPrimary ||
      row.sets === null ||
      !row.catalogReviewed ||
      !row.coverageReview ||
      [...row.direct, ...row.supporting].some((key) => !hasMuscleArtwork(key)),
  );
  return (
    <Link
      href={{ pathname: "/program/muscles", query: { day: dayId } }}
      prefetch={false}
      className={styles.daySummary}
      data-day-muscle-summary={dayId}
      aria-label={`${dayName} muscle coverage. ${label}.${incomplete ? " Mapping details and limitations available." : ""} Open muscle map.`}
      title={`${label}. Red shows planned direct sets; supporting work is separate.${incomplete ? " See map for mapping limitations." : ""}`}
    >
      <div aria-hidden="true">
        <FroggyMuscleMap coverage={coverage} compact />
      </div>
      <span aria-hidden="true" className={styles.daySummaryCaption}>
        Muscle details ↗
      </span>
    </Link>
  );
}
