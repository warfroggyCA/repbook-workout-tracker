import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeRestAudioContext } from "@/lib/rest-alert-preference";

function context(state: string, resume: () => Promise<void>) {
  const start = vi.fn();
  return {
    state, resume, currentTime: 0, destination: {},
    createOscillator: () => ({
      frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start, stop: vi.fn(),
    }),
    createGain: () => ({ gain: { setValueAtTime: vi.fn() }, connect: vi.fn() }),
    start,
  };
}

describe("rest audio lifecycle recovery", () => {
  afterEach(() => vi.useRealTimers());
  it.each(["suspended", "interrupted"])("waits for %s to become running and shares overlapping resume requests", async (state) => {
    let resolve!: () => void;
    const resume = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const audio = context(state, resume);
    const first = resumeRestAudioContext(audio as unknown as AudioContext);
    const second = resumeRestAudioContext(audio as unknown as AudioContext);
    expect(first).toBe(second);
    expect(audio.start).not.toHaveBeenCalled();
    audio.state = "running";
    resolve();
    await expect(first).resolves.toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(audio.start).toHaveBeenCalledTimes(1);
  });
  it("does not call a resolved resume audible if the context remains interrupted", async () => {
    const audio = context("interrupted", async () => undefined);
    await expect(resumeRestAudioContext(audio as unknown as AudioContext)).resolves.toBe(false);
    expect(audio.start).not.toHaveBeenCalled();
  });
  it("bounds a never-settling resume and permits a later gesture to recover", async () => {
    vi.useFakeTimers();
    const audio = context("interrupted", () => new Promise(() => undefined));
    const result = resumeRestAudioContext(audio as unknown as AudioContext, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(false);
    audio.resume = async () => { audio.state = "running"; };
    await expect(resumeRestAudioContext(audio as unknown as AudioContext)).resolves.toBe(true);
  });
  it("keeps rejected and closed contexts blocked without unhandled rejections", async () => {
    const audio = context("suspended", async () => { throw new Error("blocked"); });
    await expect(resumeRestAudioContext(audio as unknown as AudioContext)).resolves.toBe(false);
    audio.state = "closed";
    await expect(resumeRestAudioContext(audio as unknown as AudioContext)).resolves.toBe(false);
  });
});
