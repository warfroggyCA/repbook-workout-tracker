import { eq, isNull, or } from "drizzle-orm";
import type { Db } from "@/db";
import { exercises } from "@/db/schema";
import { exerciseMatchesIdentityHints } from "@/services/exercise-compat";

export type ExerciseResolution = {
  rawName: string;
  exerciseId: string | null;
  exerciseName: string | null;
  matchType: "exact" | "alias" | "none";
  matchedExercise: {
    id: string;
    name: string;
    family: string | null;
    loadType: string;
    metricType: string;
    loadSemantics: string;
    equipment: string[];
  } | null;
  candidates: Array<{
    id: string;
    name: string;
    family: string | null;
    loadType: string;
    metricType: string;
    equipment: string[];
  }>;
};

export type ExerciseIdentityHints = {
  normalized: string;
  semanticName: string;
  equipment: string | null;
  assistance: "assisted" | "weighted" | null;
};

const TOKEN_EQUIVALENTS: Record<string, string> = {
  pressdown: "pushdown",
  pulldowns: "pulldown",
  pushups: "pushup",
  dumbbells: "dumbbell",
  barbells: "barbell",
};

const EQUIPMENT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(ez[ -]?bar|e[ -]?z curl bar)\b/i, "ez_bar"],
  [/\b(dumbbell|db)\b/i, "dumbbell"],
  [/\b(kettlebell|kb)\b/i, "kettlebell"],
  [/\b(trap bar|hex bar)\b/i, "trap_bar"],
  [/\b(smith(?: machine)?)\b/i, "smith_machine"],
  [/\b(barbell|bb)\b/i, "barbell"],
  [/\b(bodyweight|body weight|body only)\b/i, "bodyweight"],
  [/\b(cable)\b/i, "cable"],
  [/\b(resistance band|band)\b/i, "bands"],
  [/\b(suspension|trx|rings?)\b/i, "suspension"],
  [/\b(machine)\b/i, "machine"],
];

export function normalizeExerciseText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/press[\s-]*down/g, "pushdown")
    .replace(/pull[\s-]*downs?/g, "pulldown")
    .replace(/push[\s-]*ups?/g, "pushup")
    .replace(/skull[\s-]*crushers?/g, "skull crusher")
    .replace(/pull[\s-]*aparts?/g, "pull apart")
    .replace(/\btricep\b/g, "triceps")
    .replace(/\bbicep\b/g, "biceps")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeLiteralExerciseText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function removeIdentityWords(value: string): string {
  let result = value.replace(/\([^)]*\)/g, " ");
  for (const [pattern] of EQUIPMENT_PATTERNS) result = result.replace(pattern, " ");
  result = result.replace(/\b(weighted|assisted)\b/gi, " ");
  return normalizeExerciseText(result);
}

export function extractExerciseIdentity(rawName: string): ExerciseIdentityHints {
  const equipment = EQUIPMENT_PATTERNS.find(([pattern]) => pattern.test(rawName))?.[1] ?? null;
  const assistance = /\bassisted\b/i.test(rawName)
    ? "assisted"
    : /\bweighted\b/i.test(rawName)
      ? "weighted"
      : null;
  return {
    normalized: normalizeExerciseText(rawName),
    semanticName: removeIdentityWords(rawName),
    equipment,
    assistance,
  };
}

function tokens(value: string): Set<string> {
  return new Set(
    normalizeExerciseText(value)
      .split(" ")
      .map((token) => TOKEN_EQUIVALENTS[token] ?? token)
      .filter((token) => token.length > 1)
  );
}

export function scoreExerciseCandidate(
  rawName: string,
  candidateName: string,
  aliases: string[] = []
): number {
  const raw = extractExerciseIdentity(rawName);
  const rawTokens = tokens(raw.semanticName);
  if (!rawTokens.size) return 0;

  let best = 0;
  for (const label of [candidateName, ...aliases]) {
    const semanticLabel = removeIdentityWords(label);
    if (raw.semanticName === semanticLabel) return 1000;
    const candidateTokens = tokens(semanticLabel);
    const overlap = [...rawTokens].filter((token) => candidateTokens.has(token)).length;
    if (!overlap) continue;
    const rawCoverage = overlap / rawTokens.size;
    const candidateCoverage = overlap / Math.max(1, candidateTokens.size);
    const phraseBonus =
      raw.semanticName.includes(semanticLabel) || semanticLabel.includes(raw.semanticName)
        ? 4
        : 0;
    best = Math.max(
      best,
      overlap * 10 + rawCoverage * 6 + candidateCoverage * 6 + phraseBonus
    );
  }
  return best;
}

export type VisibleExercise = Awaited<ReturnType<typeof loadVisibleExercises>>[number];

export async function loadVisibleExercises(db: Db, userId: string) {
  return db.query.exercises.findMany({
    where: or(isNull(exercises.userId), eq(exercises.userId, userId)),
    with: {
      aliases: true,
      family: true,
      equipmentRequirements: true,
    },
  });
}

function compatibleWithHints(exercise: VisibleExercise, hints: ExerciseIdentityHints) {
  return exerciseMatchesIdentityHints(
    {
      equipment: exercise.equipmentRequirements.map(
        (requirement) => requirement.equipmentType
      ),
      loadType: exercise.loadType,
      loadSemantics: exercise.loadSemantics,
      metricType: exercise.metricType,
      variantAttributes: exercise.variantAttributes,
    },
    hints
  );
}

function compactCandidate(exercise: VisibleExercise) {
  return {
    id: exercise.id,
    name: exercise.name,
    family: exercise.family?.name ?? null,
    loadType: exercise.loadType,
    metricType: exercise.metricType,
    loadSemantics: exercise.loadSemantics,
    equipment: exercise.equipmentRequirements.map((item) => item.equipmentType),
  };
}

function findDeterministicMatch(visible: VisibleExercise[], rawName: string) {
  const hints = extractExerciseIdentity(rawName);
  const literalName = normalizeLiteralExerciseText(rawName);
  const compatible = visible.filter((exercise) => compatibleWithHints(exercise, hints));

  const exactName = compatible.filter(
    (exercise) => normalizeLiteralExerciseText(exercise.name) === literalName
  );
  if (exactName.length === 1) return { exercise: exactName[0], matchType: "exact" as const };

  const semanticName = compatible.filter(
    (exercise) => removeIdentityWords(exercise.name) === hints.semanticName
  );
  if (semanticName.length === 1) {
    return { exercise: semanticName[0], matchType: "exact" as const };
  }

  const alias = compatible.filter((exercise) =>
    exercise.aliases.some((item) => {
      const aliasHints = extractExerciseIdentity(item.alias);
      return normalizeLiteralExerciseText(item.alias) === literalName ||
        aliasHints.semanticName === hints.semanticName;
    })
  );
  if (alias.length === 1) {
    if (!hints.equipment) {
      const semanticVariants = visible.filter(
        (exercise) => removeIdentityWords(exercise.name) === hints.semanticName
      );
      const equipmentSignatures = new Set(
        semanticVariants.map((exercise) =>
          exercise.equipmentRequirements
            .map((item) => item.equipmentType)
            .sort()
            .join("+")
        )
      );
      if (equipmentSignatures.size > 1) return null;
    }
    return { exercise: alias[0], matchType: "alias" as const };
  }
  return null;
}

/** Ranked, equipment-compatible library candidates for search and review. */
export async function findExerciseCandidates(
  db: Db,
  rawName: string,
  userId: string,
  limit = 8
) {
  const visible = await loadVisibleExercises(db, userId);
  const hints = extractExerciseIdentity(rawName);
  return visible
    .filter((exercise) => compatibleWithHints(exercise, hints))
    .map((exercise) => ({
      exercise,
      score: scoreExerciseCandidate(
        rawName,
        exercise.name,
        exercise.aliases.map((alias) => alias.alias)
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.exercise.name.localeCompare(b.exercise.name))
    .slice(0, limit)
    .map(({ exercise }) => exercise);
}

/**
 * Equipment-aware mapping. Parenthetical equipment and assistance labels are
 * parsed before names are compared, so semantically different variants can
 * never be silently combined.
 */
export async function resolveExerciseName(
  db: Db,
  rawName: string,
  userId: string
): Promise<ExerciseResolution> {
  const visible = await loadVisibleExercises(db, userId);
  return resolveExerciseNameFromLibrary(visible, rawName);
}

/**
 * Same resolution against an already-loaded library. Batch callers (Hevy
 * review builds every distinct source name) load the library once instead of
 * re-querying it per name.
 */
export function resolveExerciseNameFromLibrary(
  visible: VisibleExercise[],
  rawName: string
): ExerciseResolution {
  const deterministic = findDeterministicMatch(visible, rawName);
  if (deterministic) {
    return {
      rawName,
      exerciseId: deterministic.exercise.id,
      exerciseName: deterministic.exercise.name,
      matchType: deterministic.matchType,
      matchedExercise: compactCandidate(deterministic.exercise),
      candidates: [],
    };
  }

  const hints = extractExerciseIdentity(rawName);
  const candidates = visible
    .filter((exercise) => compatibleWithHints(exercise, hints))
    .map((exercise) => ({
      exercise,
      score: scoreExerciseCandidate(
        rawName,
        exercise.name,
        exercise.aliases.map((alias) => alias.alias)
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.exercise.name.localeCompare(b.exercise.name))
    .slice(0, 8)
    .map(({ exercise }) => compactCandidate(exercise));

  return {
    rawName,
    exerciseId: null,
    exerciseName: null,
    matchType: "none",
    matchedExercise: null,
    candidates,
  };
}
