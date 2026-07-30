import type { ExerciseMapping, ExerciseMapRequest } from "./schema";

export type SanitizedMappings = {
  /** One mapping per requested rawName, in request order. */
  mappings: ExerciseMapping[];
  /** Contract violations by the model — logged as provider-quality events. */
  violations: string[];
};

/**
 * Structural enforcement of contract 4: the model may only choose among the
 * candidates the server provided. Minted or cross-row IDs are nulled out,
 * claimed exact/alias matches are downgraded (the deterministic tier already
 * handled those), and dropped rawNames are restored as "none".
 */
export function sanitizeExerciseMappings(
  raw: ExerciseMapping[],
  request: ExerciseMapRequest
): SanitizedMappings {
  const violations: string[] = [];
  const byRawName = new Map(raw.map((m) => [m.rawName, m]));

  const mappings = request.map((req) => {
    const allowed = new Set(req.candidates.map((c) => c.exerciseId));
    const m = byRawName.get(req.rawName);
    if (!m) {
      violations.push(`model returned no mapping for "${req.rawName}"`);
      return {
        rawName: req.rawName,
        exerciseId: null,
        matchType: "none" as const,
        altCandidates: [],
      };
    }

    let exerciseId = m.exerciseId;
    if (exerciseId != null && !allowed.has(exerciseId)) {
      violations.push(
        `model minted exerciseId "${exerciseId}" for "${req.rawName}" — not among candidates`
      );
      exerciseId = null;
    }

    // The AI step only ever produces fuzzy matches; exact/alias claims are
    // downgraded so the review table renders them amber, not green.
    if (m.matchType === "exact" || m.matchType === "alias") {
      violations.push(
        `model claimed "${m.matchType}" match for "${req.rawName}" — downgraded to fuzzy`
      );
    }

    return {
      rawName: req.rawName,
      exerciseId,
      matchType: exerciseId != null ? ("fuzzy" as const) : ("none" as const),
      altCandidates: m.altCandidates.filter((a) => {
        if (allowed.has(a.exerciseId)) return true;
        violations.push(
          `model minted altCandidate "${a.exerciseId}" for "${req.rawName}"`
        );
        return false;
      }),
    };
  });

  const requested = new Set(request.map((r) => r.rawName));
  for (const m of raw) {
    if (!requested.has(m.rawName)) {
      violations.push(`model invented mapping for unrequested "${m.rawName}"`);
    }
  }

  return { mappings, violations };
}
