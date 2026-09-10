import artwork from "@/lib/froggy-muscle-regions.json";
import type { ProgramPresentation } from "@/lib/program-presentation";

/** Anatomical display groups; broad catalog terms are not silently split. */
export const MUSCLE_REGIONS = {
  chest: {
    label: "Chest",
    aliases: ["chest", "pectorals", "pectoralis major"],
  },
  shoulders: {
    label: "Shoulders (unspecified)",
    aliases: ["shoulders", "deltoids"],
  },
  reardelts: {
    label: "Rear delts",
    aliases: ["rear delts", "rear deltoids", "posterior deltoids"],
  },
  frontdelts: {
    label: "Front delts",
    aliases: ["front delts", "anterior deltoids"],
  },
  sidedelts: {
    label: "Side delts",
    aliases: ["side delts", "lateral deltoids", "middle deltoids"],
  },
  abs: {
    label: "Abdominals",
    aliases: ["abs", "abdominals", "rectus abdominis"],
  },
  obliques: { label: "Obliques", aliases: ["obliques"] },
  forearmflexors: {
    label: "Forearm flexors / grip",
    aliases: ["forearm flexors", "wrist flexors", "finger flexors"],
  },
  forearmextensors: {
    label: "Forearm extensors",
    aliases: ["forearm extensors", "wrist extensors"],
  },
  brachioradialis: {
    label: "Outer forearm \u00b7 brachioradialis",
    aliases: ["brachioradialis"],
  },
  forearms: { label: "Forearms (unspecified)", aliases: ["forearms", "grip"] },
  adductors: {
    label: "Inner thighs \u00b7 adductors",
    aliases: ["adductors", "hip adductors"],
  },
  abductors: {
    label: "Side glutes \u00b7 abductors",
    aliases: ["abductors", "hip abductors", "gluteus medius"],
  },
  uppertraps: {
    label: "Upper traps",
    aliases: ["upper traps", "upper trapezius"],
  },
  serratus: { label: "Serratus anterior", aliases: ["serratus anterior"] },
  tibialis: {
    label: "Front shins \u00b7 tibialis anterior",
    aliases: ["tibialis anterior"],
  },
  deepabs: {
    label: "Deep abdominals \u00b7 transversus",
    aliases: ["transversus abdominis"],
  },
  rotatorcuff: { label: "Rotator cuff", aliases: ["rotator cuff"] },
  hipflexors: { label: "Hip flexors", aliases: ["hip flexors", "iliopsoas"] },
  biceps: { label: "Biceps", aliases: ["biceps"] },
  triceps: { label: "Triceps", aliases: ["triceps"] },
  core: { label: "Core (unspecified)", aliases: ["core"] },
  quads: { label: "Quadriceps", aliases: ["quads", "quadriceps"] },
  hamstrings: { label: "Hamstrings", aliases: ["hamstrings"] },
  glutes: { label: "Glutes", aliases: ["glutes", "gluteals"] },
  calves: { label: "Calves", aliases: ["calves"] },
  upperback: { label: "Upper back", aliases: ["upper back"] },
  lats: { label: "Lats", aliases: ["lats", "latissimus dorsi"] },
  erectors: {
    label: "Spinal erectors",
    aliases: ["spinal erectors", "erector spinae"],
  },
} as const;
export type MuscleRegion = keyof typeof MUSCLE_REGIONS;
export const MUSCLE_KEYS = Object.keys(MUSCLE_REGIONS) as MuscleRegion[];
const aliases = new Map<string, MuscleRegion>(
  MUSCLE_KEYS.flatMap((key) =>
    [key, ...MUSCLE_REGIONS[key].aliases].map(
      (alias) => [alias, key] as [string, MuscleRegion],
    ),
  ),
);

export function muscleKey(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, " ");
  return aliases.get(normalized) ?? `unmapped:${normalized}`;
}
export function muscleLabel(key: string): string {
  return (
    MUSCLE_REGIONS[key as MuscleRegion]?.label ?? key.replace(/^unmapped:/, "")
  );
}
export function hasMuscleArtwork(key: string): key is MuscleRegion {
  return [...artwork.front, ...artwork.back].some(
    (region) => region.muscle === key,
  );
}

export type MuscleWork = {
  dayId: string;
  dayName: string;
  dayIndex: number;
  slotId: string;
  exerciseId: string;
  exerciseName: string;
  sets: number | null;
  direct: string[];
  supporting: string[];
  catalogReviewed: boolean;
  missingPrimary: boolean;
  coverageReview?: { version: string; source: string; note: string };
};
export type MuscleCoverage = {
  direct: number;
  supporting: number;
  directDays: number;
  rows: MuscleWork[];
};

function uniqueMuscles(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter(
              (v): v is string => typeof v === "string" && v.trim().length > 0,
            )
            .map(muscleKey),
        ),
      ]
    : [];
}

/** Planned working sets per slot: no warm-ups, load weighting or unilateral doubling. */
type CoverageDay = Pick<
  ProgramPresentation["days"][number],
  "lineageId" | "name"
> & {
  slots: Array<{
    id: string;
    exercise: Pick<
      ProgramPresentation["days"][number]["slots"][number]["exercise"],
      "id" | "name" | "muscleMapping"
    >;
    prescription: { sets: number } | null;
  }>;
};
export function programMuscleWork(program: {
  days: CoverageDay[];
}): MuscleWork[] {
  return program.days.flatMap((day, dayIndex) =>
    day.slots.map((slot) => {
      const direct = uniqueMuscles(slot.exercise.muscleMapping?.primary);
      const supporting = uniqueMuscles(
        slot.exercise.muscleMapping?.supporting,
      ).filter((key) => !direct.includes(key));
      const sets = slot.prescription?.sets;
      return {
        dayId: day.lineageId,
        dayName: day.name,
        dayIndex,
        slotId: slot.id,
        exerciseId: slot.exercise.id,
        exerciseName: slot.exercise.name,
        sets:
          typeof sets === "number" && Number.isSafeInteger(sets) && sets > 0
            ? sets
            : null,
        direct,
        supporting,
        catalogReviewed: slot.exercise.muscleMapping?.catalogReviewed === true,
        missingPrimary: direct.length === 0,
        coverageReview: slot.exercise.muscleMapping?.coverageReview,
      };
    }),
  );
}

/** undefined includes all days; an empty set deliberately includes none. */
export function aggregateMuscleWork(
  work: MuscleWork[],
  dayIds?: ReadonlySet<string>,
): Record<string, MuscleCoverage> {
  const result: Record<string, MuscleCoverage> = {};
  for (const row of work) {
    if (dayIds && !dayIds.has(row.dayId)) continue;
    for (const key of [...row.direct, ...row.supporting]) {
      const entry = (result[key] ??= {
        direct: 0,
        supporting: 0,
        directDays: 0,
        rows: [],
      });
      entry.rows.push(row);
      if (row.direct.includes(key)) entry.direct += row.sets ?? 0;
      else entry.supporting += row.sets ?? 0;
    }
  }
  for (const [key, entry] of Object.entries(result)) {
    entry.directDays = new Set(
      entry.rows
        .filter((row) => row.direct.includes(key) && row.sets !== null)
        .map((row) => row.dayId),
    ).size;
  }
  return result;
}

/** Fixed planned-set bands, never normalized to the selected days. */
export const DIRECT_SET_SCALE = [
  { label: "1–3", max: 3, color: "#fa7879" },
  { label: "4–6", max: 6, color: "#ec4e59" },
  { label: "7–9", max: 9, color: "#d62940" },
  { label: "10+", max: Infinity, color: "#af1534" },
] as const;
export function directSetColor(sets: number): string {
  return sets > 0 && Number.isFinite(sets)
    ? DIRECT_SET_SCALE.find((band) => sets <= band.max)!.color
    : "transparent";
}
