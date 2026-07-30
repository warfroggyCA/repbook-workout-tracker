import type {
  RestCueMilestone,
  RestCueOutcome,
} from "@/lib/rest-timer";
export type {
  RestCueChannelOutcome,
  RestCueOutcome,
} from "@/lib/rest-timer";

export const REST_ALERT_PREFERENCE_STORAGE_KEY =
  "workout-tracker:rest-alert-preference:v1";
export const REST_ALERT_PREFERENCE_CHANGE_EVENT =
  "workout-rest-alert-preference-change";

export const REST_ALERT_PREFERENCE_OPTIONS = [
  { value: "visual_only", label: "Visual only" },
  { value: "sound", label: "Sound" },
  { value: "vibration", label: "Vibration" },
  { value: "sound_and_vibration", label: "Sound + vibration" },
] as const;

export type RestAlertPreference =
  (typeof REST_ALERT_PREFERENCE_OPTIONS)[number]["value"];
export const DEFAULT_REST_ALERT_PREFERENCE: RestAlertPreference = "visual_only";

export type RestAlertPreferenceStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type RestCuePlan = {
  milestonesToAttempt: RestCueMilestone[];
  consumedMilestones: RestCueMilestone[];
  completion: RestCueOutcome["completion"];
};

type StoredPreference = { version: 1; preference: RestAlertPreference };
const PREFERENCE_KEYS = ["version", "preference"];

export function isRestAlertPreference(value: unknown): value is RestAlertPreference {
  return REST_ALERT_PREFERENCE_OPTIONS.some((option) => option.value === value);
}

export function parseRestAlertPreference(raw: string | null): RestAlertPreference {
  if (raw == null) return DEFAULT_REST_ALERT_PREFERENCE;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value != null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === PREFERENCE_KEYS.length &&
      PREFERENCE_KEYS.every((key) => Object.hasOwn(value, key)) &&
      (value as StoredPreference).version === 1 &&
      isRestAlertPreference((value as StoredPreference).preference)
    ) {
      return (value as StoredPreference).preference;
    }
  } catch {
    // Invalid device preference falls back to the non-signalling default.
  }
  return DEFAULT_REST_ALERT_PREFERENCE;
}

export function readRestAlertPreference(storage: RestAlertPreferenceStorage) {
  try {
    return parseRestAlertPreference(
      storage.getItem(REST_ALERT_PREFERENCE_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_REST_ALERT_PREFERENCE;
  }
}

export function writeRestAlertPreference(
  storage: RestAlertPreferenceStorage,
  preference: RestAlertPreference,
) {
  if (!isRestAlertPreference(preference)) return false;
  try {
    storage.setItem(
      REST_ALERT_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, preference } satisfies StoredPreference),
    );
    publishRestAlertPreferenceChange();
    return true;
  } catch {
    return false;
  }
}

export function subscribeToRestAlertPreference(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === REST_ALERT_PREFERENCE_STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(REST_ALERT_PREFERENCE_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(REST_ALERT_PREFERENCE_CHANGE_EVENT, onStoreChange);
  };
}

export function publishRestAlertPreferenceChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(REST_ALERT_PREFERENCE_CHANGE_EVENT));
  }
}

export function requestedRestCueChannels(preference: RestAlertPreference) {
  return {
    sound: preference === "sound" || preference === "sound_and_vibration",
    vibration:
      preference === "vibration" || preference === "sound_and_vibration",
  };
}

const THRESHOLDS: Array<{ milestone: RestCueMilestone; seconds: number }> = [
  { milestone: "15", seconds: 15 },
  { milestone: "10", seconds: 10 },
  { milestone: "complete", seconds: 0 },
];

export function planRestCueTransition(input: {
  previousRemainingSec: number;
  currentRemainingSec: number;
  attemptedMilestones: RestCueMilestone[];
  preference: RestAlertPreference;
  foreground: boolean;
}): RestCuePlan {
  const attempted = new Set(input.attemptedMilestones);
  const crossed = THRESHOLDS.filter(
    ({ milestone, seconds }) =>
      !attempted.has(milestone) &&
      input.previousRemainingSec > seconds &&
      input.currentRemainingSec <= seconds,
  ).map(({ milestone }) => milestone);
  const channels = requestedRestCueChannels(input.preference);
  const canRequestCue = channels.sound || channels.vibration;
  const completionCrossed = crossed.includes("complete");

  return {
    milestonesToAttempt:
      input.foreground && canRequestCue ? crossed : [],
    consumedMilestones: crossed,
    completion: !completionCrossed
      ? "not_due"
      : !input.foreground
        ? "missed_while_away"
        : canRequestCue
          ? "requested"
          : "not_due",
  };
}

export function restCueOutcome(input: {
  preference: RestAlertPreference;
  soundRequested: boolean;
  vibrationRequested: boolean;
  soundBlocked?: boolean;
  vibrationBlocked?: boolean;
  missedWhileAway?: boolean;
}): RestCueOutcome {
  const channels = requestedRestCueChannels(input.preference);
  const sound = !channels.sound
    ? "not_requested"
    : input.soundRequested
      ? "requested"
      : input.soundBlocked
        ? "blocked"
      : "unavailable";
  const vibration = !channels.vibration
    ? "not_requested"
    : input.vibrationRequested
      ? "requested"
      : input.vibrationBlocked
        ? "blocked"
      : "unavailable";
  return {
    sound,
    vibration,
    completion: input.missedWhileAway
      ? "missed_while_away"
      : sound === "requested" || vibration === "requested"
        ? "requested"
        : sound === "blocked" || vibration === "blocked"
          ? "blocked"
        : channels.sound || channels.vibration
          ? "unavailable"
          : "not_due",
  };
}

export function restCueOutcomeMessage(outcome: RestCueOutcome) {
  if (outcome.completion === "missed_while_away") {
    return "The timer finished while this app was away. No sound or vibration can be confirmed.";
  }
  const requested = [outcome.sound, outcome.vibration].filter(
    (value) => value === "requested",
  ).length;
  const unavailable = [outcome.sound, outcome.vibration].filter(
    (value) => value === "unavailable",
  ).length;
  const blocked = [outcome.sound, outcome.vibration].filter(
    (value) => value === "blocked",
  ).length;
  if (requested > 0 && (unavailable > 0 || blocked > 0)) {
    return blocked > 0
      ? "The available cue was requested. Another selected cue was blocked by this browser."
      : "The available cue was requested. Another selected cue is unavailable in this browser.";
  }
  if (requested > 0) {
    return "The selected cue was requested. Device volume, silent mode, and audio routing still apply.";
  }
  if (blocked > 0) {
    return "The selected cue was blocked by this browser. The visual ready state remains active.";
  }
  if (unavailable > 0) {
    return "The selected cue is unavailable in this browser. The visual ready state remains active.";
  }
  return "Visual ready cues only. No sound or vibration is requested.";
}
