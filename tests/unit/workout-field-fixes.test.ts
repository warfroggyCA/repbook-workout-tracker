import { afterEach, describe, expect, it, vi } from "vitest";
import { froggyClipCompleted } from "@/lib/froggy-playback";
import { hasFinePlateSteps, stepPlateEntryLoad } from "@/lib/load-entry-step";
import { ensureRestAudioProgress } from "@/lib/rest-audio-health";
import { cancelRestTonePatterns, playRestTonePattern, REST_COMPLETION_TONE_PATTERN } from "@/lib/rest-alert-preference";

const plates = { barWeight: 45, collarWeight: 0, plates: [
  { denomination: 10, countPerSide: 2 }, { denomination: 2.5, countPerSide: 2 },
  { denomination: 1, countPerSide: 1 }, { denomination: 0.25, countPerSide: 1 },
] };

describe("workout weight entry", () => {
  it("makes normal steps useful while fine steps retain fractional plates", () => {
    expect(hasFinePlateSteps(plates, "lb")).toBe(true);
    expect(stepPlateEntryLoad(65, 1, plates, "lb", "normal")).toBe(70);
    expect(stepPlateEntryLoad(65, 1, plates, "lb", "fine")).toBe(65.5);
    expect(stepPlateEntryLoad(65.5, 1, plates, "lb", "normal")).toBe(70.5);
    expect(stepPlateEntryLoad(70.5, -1, plates, "lb", "normal")).toBe(65.5);
    expect(stepPlateEntryLoad(65.5, -1, plates, "lb", "fine")).toBe(65);
  });
  it("respects boundaries, empty entries, collars and owned pairs", () => {
    expect(stepPlateEntryLoad(null, 1, plates, "lb", "normal")).toBe(45);
    expect(stepPlateEntryLoad(null, -1, plates, "lb", "normal")).toBe(null);
    expect(stepPlateEntryLoad(45, -1, plates, "lb", "fine")).toBe(45);
    expect(stepPlateEntryLoad(97.5, 1, plates, "lb", "normal")).toBe(97.5);
    expect(stepPlateEntryLoad(95, 1, plates, "lb", "normal")).toBe(97.5);
    const metric = { barWeight: 20, collarWeight: 1, plates: [
      { denomination: 1.25, countPerSide: 2 }, { denomination: .25, countPerSide: 1 },
    ] };
    expect(stepPlateEntryLoad(21, 1, metric, "kg", "normal")).toBe(23.5);
    expect(stepPlateEntryLoad(21, 1, metric, "kg", "fine")).toBe(21.5);
    expect(hasFinePlateSteps({ ...metric, plates: [{ denomination: .25, countPerSide: 0 }] }, "kg")).toBe(false);
  });
});

describe("Froggy media completion", () => {
  const playing = { duration: 6, currentTime: 5.999999999, ended: false, paused: false, seeking: false };
  it("recognizes the observed WebKit endpoint without an ended event", () => {
    expect(froggyClipCompleted(playing)).toBe(true);
    expect(froggyClipCompleted({ ...playing, ended: true, paused: true, currentTime: 6 })).toBe(true);
  });
  it("does not count a paused or in-progress seek as completion", () => {
    expect(froggyClipCompleted({ ...playing, paused: true })).toBe(false);
    expect(froggyClipCompleted({ ...playing, seeking: true })).toBe(false);
    expect(froggyClipCompleted({ ...playing, currentTime: 5.999 })).toBe(false);
  });
  it("rejects ordinary playback and unready or invalid metadata", () => {
    for (const currentTime of [0, 3, 5.96, NaN, Infinity]) {
      expect(froggyClipCompleted({ ...playing, currentTime })).toBe(false);
    }
    for (const duration of [0, -1, NaN, Infinity]) {
      expect(froggyClipCompleted({ ...playing, duration })).toBe(false);
    }
  });
});

function fakeAudio() {
  const disconnected = vi.fn();
  const gain = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  const audio = {
    state: "running", currentTime: 0, destination: {},
    suspend: vi.fn(async () => { audio.state = "suspended"; }),
    resume: vi.fn(async () => { audio.state = "running"; }),
    createOscillator: () => ({ frequency: gain, connect: vi.fn(), disconnect: disconnected, start: vi.fn(), stop: vi.fn() }),
    createGain: () => ({ gain, connect: vi.fn(), disconnect: disconnected }),
  };
  return { audio, context: audio as unknown as AudioContext, disconnected };
}

describe("foreground audio clock recovery", () => {
  afterEach(() => vi.useRealTimers());
  it("detects a frozen running clock, resets once, and verifies progress", async () => {
    vi.useFakeTimers();
    const { audio, context } = fakeAudio();
    expect(await ensureRestAudioProgress(context)).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    const result = ensureRestAudioProgress(context);
    const overlap = ensureRestAudioProgress(context);
    await vi.advanceTimersByTimeAsync(50);
    audio.currentTime = .05;
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toBe(true);
    expect(await overlap).toBe(true);
    expect(audio.suspend).toHaveBeenCalledTimes(1);
    expect(audio.resume).toHaveBeenCalledTimes(1);
  });
  it("keeps a non-advancing clock blocked and bounds a hanging suspension", async () => {
    vi.useFakeTimers();
    const { audio, context } = fakeAudio();
    await ensureRestAudioProgress(context);
    await vi.advanceTimersByTimeAsync(800);
    const result = ensureRestAudioProgress(context);
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toBe(false);
    expect(await ensureRestAudioProgress(context)).toBe(false);
    audio.suspend = vi.fn(() => new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(800);
    const hung = ensureRestAudioProgress(context);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await hung).toBe(false);
  });
  it("leaves an advancing clock alone and cancels tones by wall time", async () => {
    vi.useFakeTimers();
    const { audio, context, disconnected } = fakeAudio();
    await ensureRestAudioProgress(context);
    await vi.advanceTimersByTimeAsync(1000);
    audio.currentTime = 1;
    expect(await ensureRestAudioProgress(context)).toBe(true);
    expect(audio.suspend).not.toHaveBeenCalled();
    playRestTonePattern(context, REST_COMPLETION_TONE_PATTERN);
    await vi.advanceTimersByTimeAsync(3100);
    expect(disconnected).toHaveBeenCalledTimes(16);
    cancelRestTonePatterns(context);
    expect(disconnected).toHaveBeenCalledTimes(16);
  });
});
