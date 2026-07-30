export const BA_ROUTINE_FAILURE_MODES = [
  "timeout",
  "malformed",
  "unavailable",
] as const;

export type BaRoutineFailureMode = (typeof BA_ROUTINE_FAILURE_MODES)[number];

export const BA_ROUTINE_TIMEOUT_MESSAGE =
  "Deterministic BA routine-build request timed out.";
export const BA_ROUTINE_UNAVAILABLE_MESSAGE =
  "Deterministic BA routine-build provider is unavailable.";

export class BaRoutineBuildUnavailableError extends Error {
  readonly code = "ba_routine_build_unavailable" as const;

  constructor() {
    super(BA_ROUTINE_UNAVAILABLE_MESSAGE);
    this.name = "BaRoutineBuildUnavailableError";
  }
}

export const BA_MALFORMED_ROUTINE_BUILD_RESULT = Object.freeze({
  data: Object.freeze({
    programName: null,
    // A routine-build response must contain at least one day. Keeping the
    // invalidity small and explicit makes the schema failure deterministic.
    days: Object.freeze([]),
    rationale: null,
  }),
  confidence: 1,
  ambiguities: Object.freeze([]),
  clarifyingQuestions: Object.freeze([]),
  unparsed: Object.freeze([]),
});

export function parseBaRoutineFailureMode(
  value: string | undefined,
): BaRoutineFailureMode | null {
  if (value == null || value === "") return null;
  if ((BA_ROUTINE_FAILURE_MODES as readonly string[]).includes(value)) {
    return value as BaRoutineFailureMode;
  }
  throw new Error("Unknown deterministic BA routine-build failure mode.");
}

/**
 * Produces one fixed failure outcome. The provider must call this only after
 * its disposable BA-runtime guard succeeds; this module never reads runtime
 * environment state or user input and therefore cannot weaken that boundary.
 */
export function createBaRoutineBuildFailure(mode: BaRoutineFailureMode): unknown {
  if (mode === "timeout") {
    throw new DOMException(BA_ROUTINE_TIMEOUT_MESSAGE, "TimeoutError");
  }
  if (mode === "unavailable") {
    throw new BaRoutineBuildUnavailableError();
  }
  return BA_MALFORMED_ROUTINE_BUILD_RESULT;
}
