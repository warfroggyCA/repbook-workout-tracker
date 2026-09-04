import type { EquipmentPreparationCue } from "@/lib/session-guidance";
import {
  remainingRestSeconds,
  type DurableRestTimer,
} from "@/lib/rest-timer";

export const REST_COMPLETE_CONFIRMATION_MS = 4_000;

export const ACTIVE_WORKOUT_REST_STATES = [
  "inactive",
  "running",
  "ended_by_athlete",
  "time_elapsed",
  "cue_unavailable",
  "recovery_required",
] as const;

export type ActiveWorkoutRestState =
  (typeof ACTIVE_WORKOUT_REST_STATES)[number];

type RestPresentationBase = {
  destinationLabel: string | null;
};

export type ActiveWorkoutRestPresentation =
  | (RestPresentationBase & { state: "inactive" })
  | (RestPresentationBase & {
      state: "running";
      remainingSeconds: number;
      totalSeconds: number;
    })
  | (RestPresentationBase & {
      state: "ended_by_athlete" | "time_elapsed";
      visibleUntil: number;
    })
  | (RestPresentationBase & {
      state: "cue_unavailable";
      remainingSeconds: number;
      totalSeconds: number;
      cueProblem: "blocked" | "unavailable";
    })
  | (RestPresentationBase & {
      state: "recovery_required";
      message: string;
    });

function unsupportedRestTimerPhase(
  destinationLabel: string | null,
  phase: never,
): ActiveWorkoutRestPresentation {
  return {
    state: "recovery_required",
    destinationLabel,
    message: `The retained rest timer has an unsupported phase (${String(phase)}) and needs review.`,
  };
}

function unsupportedRestCueAvailability(
  destinationLabel: string | null,
  availability: never,
): ActiveWorkoutRestPresentation {
  return {
    state: "recovery_required",
    destinationLabel,
    message: `The rest cue has an unsupported availability state (${String(availability)}) and needs review.`,
  };
}

export function projectActiveWorkoutRestPresentation(input: {
  timer: DurableRestTimer | null;
  nowMs: number;
  destinationLabel: string | null;
  cueAvailability?: "available" | "blocked" | "unavailable";
  recoveryMessage?: string | null;
}): ActiveWorkoutRestPresentation {
  const destinationLabel = input.destinationLabel;
  if (input.recoveryMessage?.trim()) {
    return {
      state: "recovery_required",
      destinationLabel,
      message: input.recoveryMessage.trim(),
    };
  }
  const timer = input.timer;
  if (timer == null) {
    return { state: "inactive", destinationLabel };
  }
  switch (timer.phase) {
    case "continued":
      return { state: "inactive", destinationLabel };
    case "running": {
      if (input.nowMs >= timer.endsAt) {
        const visibleUntil = timer.endsAt + REST_COMPLETE_CONFIRMATION_MS;
        return input.nowMs >= visibleUntil
          ? { state: "inactive", destinationLabel }
          : { state: "time_elapsed", destinationLabel, visibleUntil };
      }
      const remainingSeconds = remainingRestSeconds(timer, input.nowMs);
      const cueAvailability = input.cueAvailability;
      if (cueAvailability == null) {
        return {
          state: "recovery_required",
          destinationLabel,
          message: "Rest cue availability is unknown and needs review.",
        };
      }
      switch (cueAvailability) {
        case "blocked":
        case "unavailable":
          return {
            state: "cue_unavailable",
            destinationLabel,
            remainingSeconds,
            totalSeconds: timer.totalSec,
            cueProblem: cueAvailability,
          };
        case "available":
          break;
        default:
          return unsupportedRestCueAvailability(
            destinationLabel,
            cueAvailability,
          );
      }
      return {
        state: "running",
        destinationLabel,
        remainingSeconds,
        totalSeconds: timer.totalSec,
      };
    }
    case "ready":
    case "skipped":
      break;
    default:
      return unsupportedRestTimerPhase(destinationLabel, timer.phase);
  }
  if (timer.readyAt == null) {
    return {
      state: "recovery_required",
      destinationLabel,
      message: "The retained rest outcome is incomplete and needs review.",
    };
  }
  const visibleUntil = timer.readyAt + REST_COMPLETE_CONFIRMATION_MS;
  if (input.nowMs >= visibleUntil) {
    return { state: "inactive", destinationLabel };
  }
  return {
    state: timer.phase === "skipped" ? "ended_by_athlete" : "time_elapsed",
    destinationLabel,
    visibleUntil,
  };
}

export const ACTIVE_WORKOUT_EQUIPMENT_STATES = [
  "ready_confirmed",
  "compatible_unselected",
  "configuration_incomplete",
  "unavailable",
  "incompatible",
  "unknown_legacy",
  "selection_pending",
  "selection_failed",
] as const;

export type ActiveWorkoutEquipmentState =
  (typeof ACTIVE_WORKOUT_EQUIPMENT_STATES)[number];

export type EquipmentLimitationEvidence =
  | "configuration_incomplete"
  | "unavailable"
  | "incompatible"
  | "unknown_legacy";

export type ActiveWorkoutEquipmentPresentation = {
  state: ActiveWorkoutEquipmentState;
  cue: EquipmentPreparationCue;
  blocksLogging: boolean;
  limitation: EquipmentLimitationEvidence | null;
};

function normalizeEquipmentLimitation(
  cue: EquipmentPreparationCue,
  limitation: EquipmentLimitationEvidence | null | undefined,
): {
  cue: EquipmentPreparationCue;
  limitation: EquipmentLimitationEvidence | null;
} {
  if (limitation == null) return { cue, limitation: null };
  switch (limitation) {
    case "configuration_incomplete":
    case "unavailable":
    case "incompatible":
    case "unknown_legacy":
      return { cue, limitation };
    default:
      return {
        cue: {
          ...cue,
          message: `Equipment evidence has an unsupported limitation (${String(limitation)}); no equipment fact was inferred.`,
        },
        limitation: "unknown_legacy",
      };
  }
}

function equipmentLimitationPresentation(input: {
  cue: EquipmentPreparationCue;
  limitation?: EquipmentLimitationEvidence | null;
}): ActiveWorkoutEquipmentPresentation {
  const normalized = normalizeEquipmentLimitation(
    input.cue,
    input.limitation ?? "unknown_legacy",
  );
  const limitation = normalized.limitation ?? "unknown_legacy";
  switch (limitation) {
    case "configuration_incomplete":
    case "unavailable":
    case "incompatible":
      return {
        state: limitation,
        cue: normalized.cue,
        blocksLogging: true,
        limitation,
      };
    case "unknown_legacy":
      return {
        state: "unknown_legacy",
        cue: normalized.cue,
        blocksLogging: false,
        limitation: "unknown_legacy",
      };
  }
}

function unsupportedEquipmentCueStatus(
  cue: EquipmentPreparationCue,
  status: never,
): ActiveWorkoutEquipmentPresentation {
  return {
    state: "unknown_legacy",
    cue: {
      ...cue,
      message: `Equipment guidance has an unsupported status (${String(status)}); no equipment fact was inferred.`,
    },
    blocksLogging: false,
    limitation: "unknown_legacy",
  };
}

function unsupportedEquipmentSelectionRuntime(
  cue: EquipmentPreparationCue,
  runtime: never,
  limitation: EquipmentLimitationEvidence | null,
): ActiveWorkoutEquipmentPresentation {
  return {
    state: "selection_failed",
    cue: {
      ...cue,
      message: `Equipment selection has an unsupported runtime state (${String(runtime)}) and needs review.`,
    },
    blocksLogging: true,
    limitation,
  };
}

/**
 * Names equipment presentation state without parsing human-readable messages.
 * A known limitation must be supplied as structured evidence; otherwise broad
 * or missing setup evidence remains unknown rather than becoming unavailable.
 */
export function projectActiveWorkoutEquipmentPresentation(input: {
  cue: EquipmentPreparationCue;
  limitation?: EquipmentLimitationEvidence | null;
  selectionRuntime?: "idle" | "pending" | "failed";
}): ActiveWorkoutEquipmentPresentation {
  const normalized = normalizeEquipmentLimitation(
    input.cue,
    input.limitation,
  );
  const selectionRuntime = input.selectionRuntime ?? "idle";
  switch (selectionRuntime) {
    case "failed":
      return {
        state: "selection_failed",
        cue: normalized.cue,
        blocksLogging: true,
        limitation: normalized.limitation,
      };
    case "pending":
      return {
        state: "selection_pending",
        cue: normalized.cue,
        blocksLogging: true,
        limitation: normalized.limitation,
      };
    case "idle":
      break;
    default:
      return unsupportedEquipmentSelectionRuntime(
        normalized.cue,
        selectionRuntime,
        normalized.limitation,
      );
  }
  if (normalized.limitation != null) {
    return equipmentLimitationPresentation(normalized);
  }
  switch (normalized.cue.status) {
    case "pending_confirmation":
    case "updating":
      return {
        state: "selection_pending",
        cue: normalized.cue,
        blocksLogging: true,
        limitation: null,
      };
    case "selected":
    case "none":
      return {
        state: "ready_confirmed",
        cue: normalized.cue,
        blocksLogging: false,
        limitation: null,
      };
    case "broad_only":
      return normalized.cue.preciseClaimAllowed
        ? {
            state: "ready_confirmed",
            cue: normalized.cue,
            blocksLogging: false,
            limitation: null,
          }
        : equipmentLimitationPresentation(normalized);
    case "choice_required":
      return {
        state: "compatible_unselected",
        cue: normalized.cue,
        blocksLogging: true,
        limitation: null,
      };
    case "configuration_incomplete":
      return equipmentLimitationPresentation({
        cue: normalized.cue,
        limitation: "configuration_incomplete",
      });
    case "unavailable":
      return equipmentLimitationPresentation(normalized);
    default:
      return unsupportedEquipmentCueStatus(
        normalized.cue,
        normalized.cue.status,
      );
  }
}

export const ACTIVE_WORKOUT_SESSION_STATES = [
  "preparation",
  "structured_warmup",
  "set_entry",
  "set_save_pending",
  "rest_running",
  "rest_complete",
  "equipment_decision",
  "skip_replace_decision",
  "correction",
  "offline_retention",
  "failure_recovery",
  "superset_transition",
  "early_finish_review",
  "ready_to_finish",
  "completion_pending",
  "completed_handoff",
] as const;

export type ActiveWorkoutSessionState =
  (typeof ACTIVE_WORKOUT_SESSION_STATES)[number];

export type ActiveWorkoutSessionStateEvidence = {
  completed: boolean;
  completionPending: boolean;
  earlyFinishReview: boolean;
  readyToFinish: boolean;
  failureRecovery: boolean;
  offlineRetention: boolean;
  correctionOpen: boolean;
  skipReplaceDecision: boolean;
  equipmentDecision: boolean;
  restState: ActiveWorkoutRestState;
  setSavePending: boolean;
  supersetTransition: boolean;
  structuredWarmup: boolean;
  preparation: boolean;
};

/**
 * Gives every session-level situation one deterministic precedence. The
 * projector is intentionally presentation-only and does not advance a session.
 */
export function projectActiveWorkoutSessionState(
  evidence: ActiveWorkoutSessionStateEvidence,
): ActiveWorkoutSessionState {
  if (evidence.completed) return "completed_handoff";
  if (evidence.failureRecovery) return "failure_recovery";
  if (evidence.completionPending) return "completion_pending";
  if (evidence.correctionOpen) return "correction";
  if (evidence.skipReplaceDecision) return "skip_replace_decision";
  if (evidence.earlyFinishReview) return "early_finish_review";
  if (evidence.equipmentDecision) return "equipment_decision";
  switch (evidence.restState) {
    case "recovery_required":
      return "failure_recovery";
    case "ended_by_athlete":
    case "time_elapsed":
      return "rest_complete";
    case "running":
    case "cue_unavailable":
      return "rest_running";
    case "inactive":
      break;
    default:
      return unsupportedSessionRestState(evidence.restState);
  }
  if (evidence.offlineRetention) return "offline_retention";
  if (evidence.setSavePending) return "set_save_pending";
  if (evidence.supersetTransition) return "superset_transition";
  if (evidence.structuredWarmup) return "structured_warmup";
  if (evidence.preparation) return "preparation";
  if (evidence.readyToFinish) return "ready_to_finish";
  return "set_entry";
}

function unsupportedSessionRestState(
  state: never,
): ActiveWorkoutSessionState {
  void state;
  return "failure_recovery";
}

export const ACTIVE_WORKOUT_SCREENSHOT_SCENARIOS = {
  setEntry390x844At115: "01-set-entry-390x844-115",
  restRunning390x844At115: "02-rest-running-390x844-115",
  restComplete390x844At115: "03-rest-complete-390x844-115",
  equipmentDecision390x844At115: "04-equipment-conflict-390x844-115",
  setEntry390x844At145: "05-set-entry-390x844-145",
  restRunning390x844At145: "06-rest-running-390x844-145",
  setEntry320x700At145: "07-set-entry-320x700-145",
  saving390x844At115: "08-saving-390x844-115",
  failed390x844At115: "09-failed-390x844-115",
  keyboard390x844At115: "10-keyboard-390x844-115",
  landscape844x390At115: "11-landscape-844x390-115",
  superset390x844At115: "12-superset-390x844-115",
  correction390x844At115: "13-correction-390x844-115",
  skipReplace390x844At115: "14-skip-replace-390x844-115",
  finishReview390x844At115: "15-finish-review-390x844-115",
} as const;
