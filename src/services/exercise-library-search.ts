import type { LibraryExerciseOption } from "@/services/routine-import";

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

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

function muscleTokenMatches(token: string, muscleText: string) {
  const accepted = [token, ...(MUSCLE_SEARCH_ALIASES[token] ?? [])];
  return accepted.some((term) => muscleText.includes(term));
}

function muscleIntentMatches(
  exercise: LibraryExerciseOption,
  tokens: string[],
  normalizedQuery: string,
  normalizedName: string
) {
  const family = normalizeSearchText(exercise.family ?? "");
  if (normalizedName.includes(normalizedQuery) || family.includes(normalizedQuery)) {
    return true;
  }
  const muscleText = normalizeSearchText(
    [
      exercise.family ?? "",
      ...exercise.primaryMuscles,
      ...exercise.secondaryMuscles,
    ].join(" ")
  );
  return tokens.every(
    (token) =>
      !MUSCLE_SEARCH_TOKENS.has(token) || muscleTokenMatches(token, muscleText)
  );
}

export function searchExerciseLibrary(
  query: string,
  library: LibraryExerciseOption[]
) {
  const normalized = normalizeSearchText(query);
  if (normalized.length < 2) return [];
  const tokens = normalized.split(" ").filter(Boolean);

  return library
    .map((exercise) => {
      const name = normalizeSearchText(exercise.name);
      const searchableText = normalizeSearchText([
        exercise.name,
        exercise.family ?? "",
        exercise.movementPattern,
        exercise.loadType,
        ...exercise.primaryMuscles,
        ...exercise.secondaryMuscles,
        ...exercise.equipment,
      ].join(" ").replaceAll("_", " "));
      const allTokensMatch = tokens.every((token) => searchableText.includes(token));
      const muscleIntentMatch = muscleIntentMatches(
        exercise,
        tokens,
        normalized,
        name
      );
      const score = name === normalized
        ? 4
        : name.startsWith(normalized)
          ? 3
          : name.includes(normalized)
            ? 2
            : allTokensMatch && muscleIntentMatch
              ? 1
              : 0;
      return { exercise, score };
    })
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.exercise.name.localeCompare(b.exercise.name)
    )
    .map((result) => result.exercise);
}
