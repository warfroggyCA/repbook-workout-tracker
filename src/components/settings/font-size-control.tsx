"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { saveFontSizePreference } from "@/app/actions/settings";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_EVENT,
  FONT_SIZE_OPTIONS,
  FONT_SIZE_STORAGE_KEY,
  isFontSizeKey,
  type FontSizeKey,
} from "@/lib/font-size";
import { cn } from "@/lib/utils";

function getFontSizeSnapshot(): FontSizeKey {
  const current = document.documentElement.dataset.fontSize;
  return isFontSizeKey(current) ? current : DEFAULT_FONT_SIZE;
}

function subscribeToFontSize(onStoreChange: () => void) {
  window.addEventListener(FONT_SIZE_EVENT, onStoreChange);
  return () => window.removeEventListener(FONT_SIZE_EVENT, onStoreChange);
}

function applyFontSize(size: FontSizeKey) {
  document.documentElement.dataset.fontSize = size;
  window.dispatchEvent(new Event(FONT_SIZE_EVENT));
}

export function FontSizeControl({ profileSize }: { profileSize: FontSizeKey }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const selected = useSyncExternalStore(
    subscribeToFontSize,
    getFontSizeSnapshot,
    () => profileSize
  );

  function chooseFontSize(size: FontSizeKey) {
    const previous = selected;
    setError(null);
    setSaved(false);
    applyFontSize(size);
    try {
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, size);
    } catch {
      // The setting still applies for this tab when storage is unavailable.
    }
    startTransition(async () => {
      const result = await saveFontSizePreference(size);
      if (result.ok) {
        setSaved(true);
        return;
      }
      applyFontSize(previous);
      try {
        localStorage.setItem(FONT_SIZE_STORAGE_KEY, previous);
      } catch {
        // The restored setting still applies for this tab.
      }
      setError(result.reason);
    });
  }

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="App font size"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {FONT_SIZE_OPTIONS.map((option) => (
          <Button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={selected === option.key}
            variant={selected === option.key ? "default" : "outline"}
            disabled={pending}
            className={cn(
              "h-auto min-h-16 min-w-0 flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left",
              selected !== option.key && "text-foreground"
            )}
            onClick={() => chooseFontSize(option.key)}
          >
            <span className="w-full break-words text-sm font-medium leading-tight">
              {option.label}
            </span>
            <span
              className={cn(
                "text-xs",
                selected === option.key
                  ? "text-primary-foreground/75"
                  : "text-muted-foreground"
              )}
            >
              {option.detail}
            </span>
          </Button>
        ))}
      </div>
      <p className="mt-1 min-h-5 text-xs text-muted-foreground" aria-live="polite">
        {pending
          ? "Saving to your profile…"
          : error
            ? error
            : saved
              ? "Saved to your profile."
              : ""}
      </p>
    </div>
  );
}
