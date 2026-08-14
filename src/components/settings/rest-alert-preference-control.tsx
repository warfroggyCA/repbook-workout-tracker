"use client";

import { useState, useSyncExternalStore } from "react";
import { BellRing, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_REST_ALERT_PREFERENCE,
  REST_ALERT_PREFERENCE_OPTIONS,
  readRestAlertPreference,
  requestedRestCueChannels,
  restCueOutcome,
  restCueOutcomeMessage,
  subscribeToRestAlertPreference,
  writeRestAlertPreference,
  type RestAlertPreference,
} from "@/lib/rest-alert-preference";
import { cn } from "@/lib/utils";

const DETAILS: Record<RestAlertPreference, string> = {
  visual_only: "On-screen ready state",
  sound: "Foreground sound (default)",
  vibration: "Vibration when supported",
  sound_and_vibration: "Both when available",
};

function getSnapshot() {
  return readRestAlertPreference(window.localStorage);
}

async function requestTestSound() {
  if (typeof AudioContext === "undefined") {
    return { requested: false, blocked: false };
  }
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") {
      await context.close();
      return { requested: false, blocked: true };
    }
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.3);
    const contextToClose = context;
    window.setTimeout(() => void contextToClose.close(), 400);
    return { requested: true, blocked: false };
  } catch {
    if (context && context.state !== "closed") void context.close();
    return { requested: false, blocked: true };
  }
}

function requestTestVibration() {
  try {
    return typeof navigator.vibrate === "function" &&
      navigator.vibrate([150, 75, 150]);
  } catch {
    return false;
  }
}

export function RestAlertPreferenceControl() {
  const selected = useSyncExternalStore(
    subscribeToRestAlertPreference,
    getSnapshot,
    () => DEFAULT_REST_ALERT_PREFERENCE,
  );
  const [message, setMessage] = useState("");
  const [testing, setTesting] = useState(false);

  function choose(preference: RestAlertPreference) {
    const saved = writeRestAlertPreference(window.localStorage, preference);
    if (!saved) {
      setMessage(
        "This browser could not retain that choice. Visual ready cues remain available.",
      );
      return;
    }
    setMessage("Saved on this browser/device.");
  }

  async function testCue() {
    setTesting(true);
    const channels = requestedRestCueChannels(selected);
    const [sound, vibrationRequested] = await Promise.all([
      channels.sound
        ? requestTestSound()
        : Promise.resolve({ requested: false, blocked: false }),
      Promise.resolve(channels.vibration ? requestTestVibration() : false),
    ]);
    setMessage(
      restCueOutcomeMessage(
        restCueOutcome({
          preference: selected,
          soundRequested: sound.requested,
          soundBlocked: sound.blocked,
          vibrationRequested,
        }),
      ),
    );
    setTesting(false);
  }

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Rest timer alert"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {REST_ALERT_PREFERENCE_OPTIONS.map((option) => (
          <Button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected === option.value}
            variant={selected === option.value ? "default" : "outline"}
            className={cn(
              "h-auto min-h-16 min-w-0 flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left",
              selected !== option.value && "text-foreground",
            )}
            onClick={() => choose(option.value)}
          >
            <span className="w-full break-words text-sm font-medium leading-tight">
              {option.label}
            </span>
            <span
              className={cn(
                "text-xs",
                selected === option.value
                  ? "text-primary-foreground/75"
                  : "text-muted-foreground",
              )}
            >
              {DETAILS[option.value]}
            </span>
          </Button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={testing}
          onClick={() => void testCue()}
        >
          {selected === "visual_only" ? (
            <BellRing className="size-4" />
          ) : (
            <Volume2 className="size-4" />
          )}
          {testing ? "Testing…" : "Test selected cue"}
        </Button>
        <p className="min-h-5 flex-1 text-xs text-muted-foreground" aria-live="polite">
          {message}
        </p>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        This choice applies only to this browser/device. Sound, silent mode,
        Bluetooth or headphones, background use, and vibration remain controlled
        by the browser and device. The on-screen ready state does not depend on
        them.
      </p>
    </div>
  );
}
