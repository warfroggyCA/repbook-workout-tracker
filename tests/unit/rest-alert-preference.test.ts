import { describe, expect, it } from "vitest";
import {
  DEFAULT_REST_ALERT_PREFERENCE,
  REST_COMPLETION_TONE_PATTERN,
  parseRestAlertPreference,
  planRestCueTransition,
  requestedRestCueChannels,
  restCueOutcome,
  restCueOutcomeMessage,
  writeRestAlertPreference,
  type RestAlertPreferenceStorage,
} from "@/lib/rest-alert-preference";

class MemoryStorage implements RestAlertPreferenceStorage {
  value: string | null = null;
  getItem() { return this.value; }
  setItem(_key: string, value: string) { this.value = value; }
  removeItem() { this.value = null; }
}

describe("rest alert preference", () => {
  it("uses the non-signalling default for absent, malformed, or unsupported values", () => {
    expect(parseRestAlertPreference(null)).toBe(DEFAULT_REST_ALERT_PREFERENCE);
    expect(parseRestAlertPreference("bad-json")).toBe("visual_only");
    expect(parseRestAlertPreference(JSON.stringify({ version: 1, preference: "alarm" }))).toBe("visual_only");
    expect(parseRestAlertPreference(JSON.stringify({ version: 1, preference: "sound", extra: true }))).toBe("visual_only");
  });

  it("round-trips each exact versioned preference", () => {
    for (const preference of ["visual_only", "sound", "vibration", "sound_and_vibration"] as const) {
      const storage = new MemoryStorage();
      expect(writeRestAlertPreference(storage, preference)).toBe(true);
      expect(parseRestAlertPreference(storage.value)).toBe(preference);
    }
  });

  it("maps preferences to only their requested channels", () => {
    expect(requestedRestCueChannels("visual_only")).toEqual({ sound: false, vibration: false });
    expect(requestedRestCueChannels("sound")).toEqual({ sound: true, vibration: false });
    expect(requestedRestCueChannels("vibration")).toEqual({ sound: false, vibration: true });
    expect(requestedRestCueChannels("sound_and_vibration")).toEqual({ sound: true, vibration: true });
  });

  it("emits 15, 10, and completion only when each threshold is crossed once", () => {
    const first = planRestCueTransition({
      previousRemainingSec: 16,
      currentRemainingSec: 9,
      attemptedMilestones: [],
      preference: "sound",
      foreground: true,
    });
    expect(first.milestonesToAttempt).toEqual(["15", "10"]);
    expect(first.consumedMilestones).toEqual(["15", "10"]);
    const repeated = planRestCueTransition({
      previousRemainingSec: 9,
      currentRemainingSec: 0,
      attemptedMilestones: first.consumedMilestones,
      preference: "sound",
      foreground: true,
    });
    expect(repeated.milestonesToAttempt).toEqual(["complete"]);
    expect(planRestCueTransition({
      previousRemainingSec: 0,
      currentRemainingSec: 0,
      attemptedMilestones: [...first.consumedMilestones, "complete"],
      preference: "sound",
      foreground: true,
    }).milestonesToAttempt).toEqual([]);
  });

  it("uses five short, separated tones for the completion cue", () => {
    expect(REST_COMPLETION_TONE_PATTERN).toHaveLength(5);
    expect(REST_COMPLETION_TONE_PATTERN.map((tone) => tone.delaySec)).toEqual([
      0,
      0.2,
      0.4,
      0.6,
      0.8,
    ]);
    expect(
      REST_COMPLETION_TONE_PATTERN.every(
        (tone) => tone.durationSec > 0 && tone.durationSec <= 0.2,
      ),
    ).toBe(true);
  });

  it("consumes missed background milestones without replaying them on return", () => {
    const plan = planRestCueTransition({
      previousRemainingSec: 20,
      currentRemainingSec: 0,
      attemptedMilestones: [],
      preference: "sound_and_vibration",
      foreground: false,
    });
    expect(plan.milestonesToAttempt).toEqual([]);
    expect(plan.consumedMilestones).toEqual(["15", "10", "complete"]);
    expect(plan.completion).toBe("missed_while_away");
  });

  it("keeps visual-only cues silent and reports requested versus unavailable channels truthfully", () => {
    expect(planRestCueTransition({
      previousRemainingSec: 1,
      currentRemainingSec: 0,
      attemptedMilestones: [],
      preference: "visual_only",
      foreground: true,
    })).toMatchObject({ milestonesToAttempt: [], consumedMilestones: ["complete"] });
    const partial = restCueOutcome({
      preference: "sound_and_vibration",
      soundRequested: true,
      vibrationRequested: false,
    });
    expect(partial).toEqual({ sound: "requested", vibration: "unavailable", completion: "requested" });
    expect(restCueOutcomeMessage(partial)).toContain("Another selected cue is unavailable");
    expect(restCueOutcomeMessage(restCueOutcome({
      preference: "vibration",
      soundRequested: false,
      vibrationRequested: false,
    }))).toContain("unavailable");
  });

  it("distinguishes a browser-blocked request from an unavailable channel", () => {
    const blocked = restCueOutcome({
      preference: "sound_and_vibration",
      soundRequested: false,
      soundBlocked: true,
      vibrationRequested: false,
    });
    expect(blocked).toEqual({
      sound: "blocked",
      vibration: "unavailable",
      completion: "blocked",
    });
    expect(restCueOutcomeMessage(blocked)).toContain("blocked by this browser");
    const partial = restCueOutcome({
      preference: "sound_and_vibration",
      soundRequested: true,
      vibrationRequested: false,
      vibrationBlocked: true,
    });
    expect(restCueOutcomeMessage(partial)).toContain("Another selected cue was blocked");
  });
});
