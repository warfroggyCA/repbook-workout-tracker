"use client";

import { useLayoutEffect } from "react";
import {
  FONT_SIZE_EVENT,
  FONT_SIZE_STORAGE_KEY,
  type FontSizeKey,
} from "@/lib/font-size";

function applyProfileFontSize(profileSize: FontSizeKey) {
  document.documentElement.dataset.fontSize = profileSize;
  window.dispatchEvent(new Event(FONT_SIZE_EVENT));
  try {
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, profileSize);
  } catch {
    // The profile setting still applies for this tab when storage is unavailable.
  }
}

export function FontSizeInitializer({
  profileSize,
}: {
  profileSize: FontSizeKey;
}) {
  useLayoutEffect(() => applyProfileFontSize(profileSize), [profileSize]);
  return null;
}
