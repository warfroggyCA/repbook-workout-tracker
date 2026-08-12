export const EQUIPMENT_FILTERS = [
  "barbell",
  "dumbbell",
  "cable",
  "machine",
  "bands",
  "bodyweight",
] as const;

export const BODY_AREA_FILTERS = [
  "chest",
  "back",
  "shoulders",
  "arms",
  "core",
  "hips_glutes",
  "quads",
  "hamstrings",
  "calves",
] as const;

export const MOVEMENT_FILTERS = [
  "squat",
  "hinge",
  "lunge",
  "horizontal_push",
  "horizontal_pull",
  "vertical_push",
  "vertical_pull",
  "carry",
  "rotation",
  "mobility",
  "isolation",
] as const;

export const SHORTCUT_FILTERS = [
  "current_program",
  "recent",
  "frequent",
] as const;

export type BodyAreaFilter = (typeof BODY_AREA_FILTERS)[number];
export type MovementFilter = (typeof MOVEMENT_FILTERS)[number];
export type ShortcutFilter = (typeof SHORTCUT_FILTERS)[number];

export type ExerciseMediaPreview = {
  thumbnailUrl?: string | null;
  kind?: "image" | "video" | null;
  images?: Array<{
    url: string;
    alt: string;
    width: number;
    height: number;
  }>;
  video?: {
    url: string;
    posterUrl?: string | null;
    title?: string | null;
  } | null;
};

export type ExerciseDiscoveryItem = {
  id: string;
  name: string;
  activityClass?: string;
  family: string | null;
  movementPattern: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  equipment: string[];
  loadType: string;
  metricType: string;
  loadSemantics: string;
  variantAttributes: Record<string, string | boolean | null | undefined>;
  cautionBodyParts: string[];
  available: boolean;
  unavailableReason: string | null;
  missingEquipment?: string[];
  constraintBlocked?: boolean;
  equipmentFitStatus?: import("@/lib/exercise-equipment-fit").ExerciseEquipmentFitStatus;
  equipmentFitReason?: string;
  equipmentFit?: import("@/lib/exercise-equipment-fit").ExerciseEquipmentFitResolution;
  inCurrentProgram?: boolean;
  recentRank?: number | null;
  useCount?: number;
  frequentlyUsed?: boolean;
  media?: ExerciseMediaPreview | null;
};

export type ExerciseDiscoveryFilters = {
  query: string;
  equipment: string[];
  bodyAreas: BodyAreaFilter[];
  movements: MovementFilter[];
  availability: "all" | "available";
  shortcuts: ShortcutFilter[];
};

export type ExerciseDiscoveryFamily = {
  key: string;
  name: string;
  variants: ExerciseDiscoveryItem[];
};

type DiscoveryLibraryRecord = Pick<
  ExerciseDiscoveryItem,
  | "id"
  | "name"
  | "activityClass"
  | "family"
  | "movementPattern"
  | "primaryMuscles"
  | "secondaryMuscles"
  | "equipment"
  | "loadType"
  | "metricType"
  | "loadSemantics"
  | "variantAttributes"
  | "cautionBodyParts"
  | "available"
  | "unavailableReason"
  | "missingEquipment"
  | "constraintBlocked"
  | "equipmentFitStatus"
  | "equipmentFitReason"
  | "equipmentFit"
>;

/** Explicit projection keeps source, rights, and provenance bookkeeping out. */
export function exerciseDiscoveryItemFromLibrary(
  exercise: DiscoveryLibraryRecord,
  signals: Partial<
    Pick<
      ExerciseDiscoveryItem,
      "inCurrentProgram" | "recentRank" | "useCount" | "frequentlyUsed" | "media"
    >
  > = {}
): ExerciseDiscoveryItem {
  return {
    id: exercise.id,
    name: exercise.name,
    activityClass: exercise.activityClass,
    family: exercise.family,
    movementPattern: exercise.movementPattern,
    primaryMuscles: exercise.primaryMuscles,
    secondaryMuscles: exercise.secondaryMuscles,
    equipment: exercise.equipment,
    loadType: exercise.loadType,
    metricType: exercise.metricType,
    loadSemantics: exercise.loadSemantics,
    variantAttributes: exercise.variantAttributes,
    cautionBodyParts: exercise.cautionBodyParts,
    available: exercise.available,
    unavailableReason: exercise.unavailableReason,
    missingEquipment: exercise.missingEquipment,
    constraintBlocked: exercise.constraintBlocked,
    equipmentFitStatus: exercise.equipmentFitStatus,
    equipmentFitReason: exercise.equipmentFitReason,
    equipmentFit: exercise.equipmentFit,
    ...signals,
  };
}

export const DEFAULT_EXERCISE_FILTERS: ExerciseDiscoveryFilters = {
  query: "",
  equipment: [],
  bodyAreas: [],
  movements: [],
  availability: "available",
  shortcuts: [],
};

const BODY_AREA_MUSCLES: Record<BodyAreaFilter, string[]> = {
  chest: ["chest", "pecs", "pectorals"],
  back: ["back", "upper back", "lats", "traps", "rhomboids"],
  shoulders: ["shoulders", "front delts", "rear delts", "side delts", "delts"],
  arms: ["biceps", "triceps", "forearms", "grip"],
  core: ["core", "abs", "obliques"],
  hips_glutes: ["glutes", "hip flexors", "adductors", "abductors"],
  quads: ["quads", "quadriceps"],
  hamstrings: ["hamstrings"],
  calves: ["calves"],
};

const MUSCLE_SEARCH_TOKENS = new Set([
  "chest",
  "pec",
  "pecs",
  "pectoral",
  "pectorals",
  "back",
  "lat",
  "lats",
  "trap",
  "traps",
  "rhomboid",
  "rhomboids",
  "shoulder",
  "shoulders",
  "delt",
  "delts",
  "bicep",
  "biceps",
  "tricep",
  "triceps",
  "forearm",
  "forearms",
  "grip",
  "core",
  "ab",
  "abs",
  "oblique",
  "obliques",
  "glute",
  "glutes",
  "quad",
  "quads",
  "quadricep",
  "quadriceps",
  "hamstring",
  "hamstrings",
  "calf",
  "calves",
  "adductor",
  "adductors",
  "abductor",
  "abductors",
]);

const MUSCLE_SEARCH_ALIASES: Record<string, string[]> = {
  pec: ["chest"],
  pecs: ["chest"],
  pectoral: ["chest"],
  pectorals: ["chest"],
  lat: ["lats", "back"],
  lats: ["back"],
  trap: ["traps", "back"],
  traps: ["back"],
  rhomboid: ["rhomboids", "back"],
  rhomboids: ["back"],
  shoulder: ["shoulders", "delts"],
  shoulders: ["delts"],
  delt: ["delts", "shoulders"],
  delts: ["shoulders"],
  bicep: ["biceps"],
  tricep: ["triceps"],
  forearm: ["forearms"],
  ab: ["abs", "core"],
  abs: ["core"],
  oblique: ["obliques", "core"],
  glute: ["glutes"],
  quad: ["quads", "quadriceps"],
  quads: ["quadriceps"],
  quadricep: ["quadriceps", "quads"],
  quadriceps: ["quads"],
  hamstring: ["hamstrings"],
  calf: ["calves"],
  calves: ["calf"],
  adductor: ["adductors"],
  abductor: ["abductors"],
};

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function movementMatches(pattern: string, filter: MovementFilter) {
  if (filter === "isolation") return pattern.startsWith("isolation_");
  if (filter === "mobility") return pattern === "mobility" || pattern === "stretch";
  return pattern === filter;
}

function equipmentMatches(item: ExerciseDiscoveryItem, filter: string) {
  if (filter === "barbell") {
    return item.equipment.some((equipment) =>
      ["barbell", "ez_bar", "trap_bar"].includes(equipment)
    );
  }
  if (filter === "machine") {
    return item.equipment.some(
      (equipment) => equipment === "machine" || equipment === "smith_machine"
    );
  }
  return item.equipment.includes(filter);
}

function bodyAreaMatches(item: ExerciseDiscoveryItem, filter: BodyAreaFilter) {
  const primary = item.primaryMuscles.map(normalize);
  return BODY_AREA_MUSCLES[filter].some((muscle) => primary.includes(muscle));
}

function muscleTokenMatches(token: string, muscleText: string) {
  const accepted = [token, ...(MUSCLE_SEARCH_ALIASES[token] ?? [])];
  return accepted.some((term) => muscleText.includes(term));
}

function muscleIntentMatches(
  item: ExerciseDiscoveryItem,
  tokens: string[],
  query: string,
  name: string,
  family: string
) {
  if (name.includes(query) || family.includes(query)) return true;
  const muscleText = normalize(
    [
      item.family ?? "",
      ...item.primaryMuscles,
      ...item.secondaryMuscles,
    ].join(" ")
  );
  return tokens.every(
    (token) =>
      !MUSCLE_SEARCH_TOKENS.has(token) || muscleTokenMatches(token, muscleText)
  );
}

function shortcutMatches(item: ExerciseDiscoveryItem, shortcut: ShortcutFilter) {
  if (shortcut === "current_program") return item.inCurrentProgram === true;
  if (shortcut === "recent") return item.recentRank != null;
  return item.frequentlyUsed === true;
}

function searchScore(item: ExerciseDiscoveryItem, rawQuery: string) {
  const query = normalize(rawQuery);
  if (!query) return 1;
  const name = normalize(item.name);
  const family = normalize(item.family ?? "");
  const tokens = query.split(" ").filter(Boolean);
  const searchable = normalize(
    [
      item.name,
      item.family ?? "",
      item.movementPattern.replaceAll("_", " "),
      ...item.primaryMuscles,
      ...item.secondaryMuscles,
      ...item.equipment.map((value) => value.replaceAll("_", " ")),
    ].join(" ")
  );
  if (!tokens.every((token) => searchable.includes(token))) return 0;
  if (!muscleIntentMatches(item, tokens, query, name, family)) return 0;
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 65;
  if (family === query) return 55;
  if (family.startsWith(query)) return 45;
  return 20;
}

export function activeAdvancedExerciseFilterCount(filters: ExerciseDiscoveryFilters) {
  return (
    filters.equipment.length +
    filters.bodyAreas.length +
    filters.movements.length
  );
}

/**
 * Multi-select choices are ORed within one category and ANDed between
 * categories. Search establishes relevance; filters only remove results.
 */
export function discoverExerciseFamilies(
  items: ExerciseDiscoveryItem[],
  filters: ExerciseDiscoveryFilters
): ExerciseDiscoveryFamily[] {
  const scored = items
    .map((item) => ({ item, score: searchScore(item, filters.query) }))
    .filter(({ item, score }) => {
      if (score === 0) return false;
      if (filters.availability === "available" && !item.available) return false;
      if (
        filters.equipment.length > 0 &&
        !filters.equipment.some((equipment) => equipmentMatches(item, equipment))
      ) return false;
      if (
        filters.bodyAreas.length > 0 &&
        !filters.bodyAreas.some((area) => bodyAreaMatches(item, area))
      ) return false;
      if (
        filters.movements.length > 0 &&
        !filters.movements.some((movement) =>
          movementMatches(item.movementPattern, movement)
        )
      ) return false;
      if (
        filters.shortcuts.length > 0 &&
        !filters.shortcuts.some((shortcut) => shortcutMatches(item, shortcut))
      ) return false;
      return true;
    });

  const grouped = new Map<
    string,
    { name: string; variants: typeof scored; bestScore: number; bestSignal: number }
  >();
  for (const entry of scored) {
    const name = entry.item.family?.trim() || entry.item.name;
    const key = normalize(name) || entry.item.id;
    const signal =
      (entry.item.inCurrentProgram ? 10000 : 0) +
      (entry.item.recentRank != null ? 1000 - entry.item.recentRank : 0) +
      (entry.item.useCount ?? 0);
    const family = grouped.get(key) ?? {
      name,
      variants: [],
      bestScore: 0,
      bestSignal: 0,
    };
    family.variants.push(entry);
    family.bestScore = Math.max(family.bestScore, entry.score);
    family.bestSignal = Math.max(family.bestSignal, signal);
    grouped.set(key, family);
  }

  return [...grouped.entries()]
    .map(([key, family]) => ({
      key,
      name: family.name,
      bestScore: family.bestScore,
      bestSignal: family.bestSignal,
      variants: family.variants
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(b.item.available) - Number(a.item.available) ||
            a.item.name.localeCompare(b.item.name)
        )
        .map(({ item }) => item),
    }))
    .sort((a, b) => {
      if (filters.query.trim()) {
        return b.bestScore - a.bestScore || a.name.localeCompare(b.name);
      }
      if (filters.shortcuts.length > 0) {
        return b.bestSignal - a.bestSignal || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    })
    .map(({ key, name, variants }) => ({ key, name, variants }));
}

export function visibleEquipmentFilters(items: ExerciseDiscoveryItem[]) {
  const present = new Set(items.flatMap((item) => item.equipment));
  const availableEquipment = new Set(
    items.filter((item) => item.available).flatMap((item) => item.equipment)
  );
  const base = EQUIPMENT_FILTERS.filter((item) => present.has(item));
  const specialty = [...present]
    .filter(
      (item) =>
        availableEquipment.has(item) &&
        !EQUIPMENT_FILTERS.includes(item as (typeof EQUIPMENT_FILTERS)[number])
    )
    .sort((a, b) => a.localeCompare(b));
  return [...base, ...specialty];
}
