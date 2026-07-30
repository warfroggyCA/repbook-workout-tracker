"use client";

import { useCallback, useEffect, useReducer, useSyncExternalStore } from "react";
import { createContextualNoteAction } from "@/app/actions/contextual-notes";
import {
  getContextualNoteOutboxServerSnapshot,
  getContextualNoteOutboxSnapshot,
  markContextualNoteOutboxNeedsAttention,
  markContextualNoteOutboxSyncing,
  markContextualNoteOutboxTransientFailure,
  mutateContextualNoteOutboxInBrowserUnlocked,
  removeContextualNoteOutboxEntry,
  retryContextualNoteOutboxEntry,
  subscribeToContextualNoteOutbox,
  withContextualNoteOutboxLock,
  type ContextualNoteOutboxEntry,
} from "@/lib/contextual-note-outbox";

type ContextualNoteSaveAction = (
  input: ContextualNoteOutboxEntry["payload"]
) => Promise<unknown>;

type ParsedSaveResult =
  | { ok: true; clientKey: string; payloadHash: string }
  | { ok: false; reason: string; retryable: boolean }
  | { ok: false; malformed: true };

const activeSyncs = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function parseContextualNoteSaveResult(value: unknown): ParsedSaveResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return { ok: false, malformed: true };
  }
  if (value.ok === false) {
    return typeof value.reason === "string" && typeof value.retryable === "boolean"
      ? { ok: false, reason: value.reason, retryable: value.retryable }
      : { ok: false, malformed: true };
  }
  return typeof value.clientKey === "string" && typeof value.payloadHash === "string"
    ? { ok: true, clientKey: value.clientKey, payloadHash: value.payloadHash }
    : { ok: false, malformed: true };
}

function mutateUnlocked(
  ownerId: string,
  mutation: Parameters<typeof mutateContextualNoteOutboxInBrowserUnlocked>[1]
) {
  return mutateContextualNoteOutboxInBrowserUnlocked(ownerId, mutation);
}

export async function syncContextualNoteEntry(
  ownerId: string,
  original: ContextualNoteOutboxEntry,
  save: ContextualNoteSaveAction = createContextualNoteAction
) {
  // Without Web Locks, a second tab could race this read-modify-write drain and
  // delete or overwrite a different queued note. Keep the device copy intact.
  if (typeof navigator === "undefined" || !navigator.locks) return;
  const activeKey = `${ownerId}:${original.clientKey}`;
  if (activeSyncs.has(activeKey)) return;
  activeSyncs.add(activeKey);
  try {
    await withContextualNoteOutboxLock(async () => {
      let entry = getContextualNoteOutboxSnapshot(ownerId).entries.find(
        (candidate) =>
          candidate.clientKey === original.clientKey &&
          candidate.payloadHash === original.payloadHash
      );
      if (!entry || entry.status === "needs_attention") return;

      // A held Web Lock proves that no other tab is still performing this sync.
      // Therefore a persisted syncing state is an interrupted attempt and is safe
      // to return to the queue without changing its identity or payload.
      if (entry.status === "syncing") {
        const recovered = mutateUnlocked(ownerId, (storage) =>
          retryContextualNoteOutboxEntry(
            storage,
            ownerId,
            entry!.clientKey,
            entry!.payloadHash
          )
        );
        if (!recovered.ok || !recovered.entry) return;
        entry = recovered.entry;
      }
      if (
        entry.nextAttemptAtISO &&
        Date.parse(entry.nextAttemptAtISO) > Date.now()
      ) {
        return;
      }
      if (typeof navigator !== "undefined" && !navigator.onLine) return;

      const syncing = mutateUnlocked(ownerId, (storage) =>
        markContextualNoteOutboxSyncing(
          storage,
          ownerId,
          entry!.clientKey,
          entry!.payloadHash
        )
      );
      if (!syncing.ok || !syncing.entry) return;
      entry = syncing.entry;

      let rawResult: unknown;
      try {
        rawResult = await save(entry.payload);
      } catch {
        mutateUnlocked(ownerId, (storage) =>
          markContextualNoteOutboxTransientFailure(
            storage,
            ownerId,
            entry!.clientKey,
            entry!.payloadHash,
            "The connection was interrupted. This note remains queued on this device."
          )
        );
        return;
      }

      const result = parseContextualNoteSaveResult(rawResult);
      if (!result.ok) {
        if ("malformed" in result || !result.retryable) {
          mutateUnlocked(ownerId, (storage) =>
            markContextualNoteOutboxNeedsAttention(
              storage,
              ownerId,
              entry!.clientKey,
              entry!.payloadHash,
              "malformed" in result
                ? "The server did not return a valid note acknowledgement. The device copy was kept for review."
                : result.reason
            )
          );
        } else {
          mutateUnlocked(ownerId, (storage) =>
            markContextualNoteOutboxTransientFailure(
              storage,
              ownerId,
              entry!.clientKey,
              entry!.payloadHash,
              result.reason
            )
          );
        }
        return;
      }

      if (
        result.clientKey !== entry.clientKey ||
        result.payloadHash !== entry.payloadHash
      ) {
        mutateUnlocked(ownerId, (storage) =>
          markContextualNoteOutboxNeedsAttention(
            storage,
            ownerId,
            entry!.clientKey,
            entry!.payloadHash,
            "The server acknowledged different note content. The device copy was kept for recovery."
          )
        );
        return;
      }

      mutateUnlocked(ownerId, (storage) =>
        removeContextualNoteOutboxEntry(
          storage,
          ownerId,
          entry!.clientKey,
          entry!.payloadHash
        )
      );
    });
  } finally {
    activeSyncs.delete(activeKey);
  }
}

export function registerContextualNoteOutboxWakeListeners(wake: () => void) {
  const onWake = () => wake();
  const onVisible = () => {
    if (document.visibilityState === "visible") wake();
  };
  window.addEventListener("online", onWake);
  window.addEventListener("focus", onWake);
  window.addEventListener("pageshow", onWake);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("online", onWake);
    window.removeEventListener("focus", onWake);
    window.removeEventListener("pageshow", onWake);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function ContextualNoteOutboxSync({ ownerId }: { ownerId: string }) {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeToContextualNoteOutbox(ownerId, onStoreChange),
    [ownerId]
  );
  const getSnapshot = useCallback(
    () => getContextualNoteOutboxSnapshot(ownerId),
    [ownerId]
  );
  const getServerSnapshot = useCallback(
    () => getContextualNoteOutboxServerSnapshot(ownerId),
    [ownerId]
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [wakeCounter, wake] = useReducer((value: number) => value + 1, 0);

  useEffect(() => registerContextualNoteOutboxWakeListeners(wake), []);

  useEffect(() => {
    const retryAt = snapshot.entries
      .filter(
        (entry) => entry.status === "queued" && entry.nextAttemptAtISO != null
      )
      .map((entry) => Date.parse(entry.nextAttemptAtISO!))
      .filter((time) => time > Date.now())
      .sort((left, right) => left - right)[0];
    if (retryAt == null) return;
    const timer = window.setTimeout(
      () => wake(),
      Math.min(Math.max(retryAt - Date.now(), 0), 300_000)
    );
    return () => window.clearTimeout(timer);
  }, [snapshot.entries]);

  useEffect(() => {
    for (const entry of snapshot.entries) {
      if (entry.status === "needs_attention") continue;
      if (
        entry.status === "queued" &&
        entry.nextAttemptAtISO &&
        Date.parse(entry.nextAttemptAtISO) > Date.now()
      ) {
        continue;
      }
      void syncContextualNoteEntry(ownerId, entry);
    }
  }, [ownerId, snapshot.entries, wakeCounter]);

  return null;
}
