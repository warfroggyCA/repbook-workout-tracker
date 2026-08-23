import { describe, expect, it } from "vitest";
import {
  DEFAULT_REST_ALERT_PREFERENCE,
  REST_COMPLETION_TONE_PATTERN,
  REST_COUNTDOWN_TICK_PATTERN,
  parseRestAlertPreference,
  planRestCueTransition,
  prepareRestAudioContext,
  primeRestAudioContext,
  requestedRestCueChannels,
  restCountdownCueKey,
  restCueOutcome,
  restCueOutcomeMessage,
  restSoundChannelState,
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
  it("distinguishes supported but gesture-blocked sound from unavailable audio", () => {
    expect(restSoundChannelState({
      requested: true,
      audioSupported: true,
      contextState: null,
    })).toBe("blocked");
    expect(restSoundChannelState({
      requested: true,
      audioSupported: false,
      contextState: null,
    })).toBe("unavailable");
  });

  it("requests foreground sound by default for absent or invalid device preferences", () => {
    expect(parseRestAlertPreference(null)).toBe(DEFAULT_REST_ALERT_PREFERENCE);
    expect(parseRestAlertPreference("bad-json")).toBe("sound");
    expect(parseRestAlertPreference(JSON.stringify({ version: 1, preference: "alarm" }))).toBe("sound");
    expect(parseRestAlertPreference(JSON.stringify({ version: 1, preference: "sound", extra: true }))).toBe("sound");
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

  it("requests one foreground sound tick for each second from 9 through 1", () => {
    const input = {
      generationId: "timer-a",
      preference: "sound" as const,
      foreground: true,
      tenSecondMilestoneDue: false,
    };
    expect(restCountdownCueKey({ ...input, remainingSec: 9, previousCueKey: null }))
      .toBe("timer-a:9");
    expect(restCountdownCueKey({ ...input, remainingSec: 9, previousCueKey: "timer-a:9" }))
      .toBeNull();
    expect(restCountdownCueKey({ ...input, remainingSec: 1, previousCueKey: "timer-a:2" }))
      .toBe("timer-a:1");
    expect(restCountdownCueKey({ ...input, remainingSec: 10, previousCueKey: null }))
      .toBeNull();
    expect(restCountdownCueKey({ ...input, remainingSec: 0, previousCueKey: null }))
      .toBeNull();
    expect(restCountdownCueKey({ ...input, remainingSec: 8, previousCueKey: null, foreground: false }))
      .toBeNull();
    expect(restCountdownCueKey({ ...input, remainingSec: 8, previousCueKey: null, preference: "visual_only" }))
      .toBeNull();
  });

  it("uses a louder multi-second alarm and a distinct mechanical countdown tick", () => {
    expect(REST_COMPLETION_TONE_PATTERN).toHaveLength(8);
    expect(REST_COMPLETION_TONE_PATTERN.map((tone) => tone.delaySec)).toEqual([
      0,
      0.32,
      0.64,
      0.96,
      1.28,
      1.6,
      1.92,
      2.36,
    ]);
    expect(
      REST_COMPLETION_TONE_PATTERN.every(
        (tone) =>
          tone.durationSec >= 0.24 &&
          tone.peakGain >= 0.42 &&
          tone.wave === "square",
      ),
    ).toBe(true);
    expect(REST_COUNTDOWN_TICK_PATTERN).toHaveLength(2);
    expect(REST_COUNTDOWN_TICK_PATTERN[0]).toMatchObject({
      frequencyHz: 1180,
      peakGain: 0.34,
      wave: "square",
    });
  });

  it("starts a silent source immediately so a user gesture can unlock delayed audio", () => {
    const calls: string[] = [];
    const oscillator = {
      type: "square",
      frequency: { setValueAtTime: (value: number, at: number) => calls.push(`frequency:${value}:${at}`) },
      connect: () => calls.push("oscillator:connect"),
      start: (at: number) => calls.push(`start:${at}`),
      stop: (at: number) => calls.push(`stop:${at}`),
    };
    const gain = {
      gain: { setValueAtTime: (value: number, at: number) => calls.push(`gain:${value}:${at}`) },
      connect: () => calls.push("gain:connect"),
    };
    primeRestAudioContext({
      currentTime: 3,
      destination: {},
      createOscillator: () => oscillator,
      createGain: () => gain,
    } as unknown as AudioContext);
    expect(calls).toEqual([
      "frequency:440:3",
      "gain:0.0001:3",
      "oscillator:connect",
      "gain:connect",
      "start:3",
      "stop:3.02",
    ]);
  });

  it("primes every consecutive timer gesture and replaces a closed context", () => {
    const starts: number[] = [];
    const contexts: Array<AudioContext & { state: AudioContextState }> = [];
    class FakeAudioContext {
      currentTime = contexts.length;
      destination = {};
      state: AudioContextState = "running";
      createOscillator() {
        return {
          type: "sine" as OscillatorType,
          frequency: { setValueAtTime: () => undefined },
          connect: () => undefined,
          start: (at: number) => starts.push(at),
          stop: () => undefined,
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime: () => undefined },
          connect: () => undefined,
        };
      }
      constructor() {
        contexts.push(this as unknown as AudioContext & {
          state: AudioContextState;
        });
      }
    }
    const Constructor = FakeAudioContext as unknown as new () => AudioContext;

    const first = prepareRestAudioContext(null, Constructor);
    const second = prepareRestAudioContext(first, Constructor);
    expect(second).toBe(first);
    expect(starts).toHaveLength(2);

    Object.defineProperty(first, "state", { value: "closed" });
    const third = prepareRestAudioContext(first, Constructor);
    expect(third).not.toBe(first);
    expect(contexts).toHaveLength(2);
    expect(starts).toHaveLength(3);
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
