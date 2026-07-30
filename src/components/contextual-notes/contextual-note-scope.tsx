"use client";

import { useEffect } from "react";
import {
  publishContextualNoteScope,
  type ContextualNoteScopeValue,
} from "@/lib/contextual-note-ui";

export function ContextualNoteScope({ value }: { value: ContextualNoteScopeValue }) {
  useEffect(() => {
    // The provider and a route scope can mount in the same commit. Publish on
    // the next task so the provider's listener is present regardless of React's
    // parent/child effect ordering.
    const timer = window.setTimeout(() => publishContextualNoteScope(value), 0);
    return () => {
      window.clearTimeout(timer);
      publishContextualNoteScope(null);
    };
  }, [value]);
  return null;
}
