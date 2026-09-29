"use client";

import { deliverNextWorkoutCommand } from "@/lib/workout-command-queue";
import { createContextualNoteAction } from "@/app/actions/contextual-notes";
import {
  getContextualNoteOutboxSnapshot,
  markContextualNoteOutboxNeedsAttention,
  markContextualNoteOutboxSyncing,
  markContextualNoteOutboxTransientFailure,
  mutateContextualNoteOutboxInBrowserUnlocked,
  removeContextualNoteOutboxEntry,
  retryContextualNoteOutboxEntry,
  withContextualNoteOutboxLock,
  type ContextualNoteOutboxEntry,
} from "@/lib/contextual-note-outbox";
import {
  deploymentRecoveryRequired,
  reportDeploymentMismatch,
  withDocumentActionDeadline,
  isDocumentActionTimeout,
  reportDocumentActionTimeout,
} from "@/lib/deployment-recovery";

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
  if (deploymentRecoveryRequired()) return;
  // Without Web Locks, a second tab could race this read-modify-write drain and
  // delete or overwrite a different queued note. Keep the device copy intact.
  if (typeof navigator === "undefined" || !navigator.locks) return;
  const activeKey = `${ownerId}:${original.clientKey}`;
  if (activeSyncs.has(activeKey)) return;
  activeSyncs.add(activeKey);
  try {
    await deliverNextWorkoutCommand(ownerId, command => command.kind === "note" && command.entry.clientKey === original.clientKey, async () => {
      const entry = await withContextualNoteOutboxLock(() => {
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
        return syncing.entry;
      });
      if (!entry) return;
      const mutate = (mutation: Parameters<typeof mutateUnlocked>[1]) =>
        withContextualNoteOutboxLock(() => mutateUnlocked(ownerId, mutation));

      let rawResult: unknown;
      try {
        rawResult = await withDocumentActionDeadline(save(entry.payload));
      } catch (error) {
        const timedOut = isDocumentActionTimeout(error);
        if (timedOut) reportDocumentActionTimeout();
        const deploymentMismatch = timedOut || reportDeploymentMismatch(error);
        await mutate((storage) =>
          markContextualNoteOutboxTransientFailure(
            storage,
            ownerId,
            entry!.clientKey,
            entry!.payloadHash,
            timedOut
              ? "Repbook did not confirm this note in time. It is safe on this device. Reload and retry safely."
              : deploymentMismatch
              ? "Repbook was updated. This note is safe on this device and will retry after you reload."
              : "The connection was interrupted. This note remains queued on this device."
          )
        );
        return;
      }

      const result = parseContextualNoteSaveResult(rawResult);
      if (!result.ok) {
        if ("malformed" in result || !result.retryable) {
          await mutate((storage) =>
            markContextualNoteOutboxNeedsAttention(
              storage,
              ownerId,
              entry!.clientKey,
              entry!.payloadHash,
              "malformed" in result
                ? "Repbook could not confirm that this note saved. A copy is kept on this device."
                : result.reason
            )
          );
        } else {
          await mutate((storage) =>
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
        await mutate((storage) =>
          markContextualNoteOutboxNeedsAttention(
            storage,
            ownerId,
            entry!.clientKey,
            entry!.payloadHash,
            "The saved note differs from the copy on this device. Both have been kept so you can check them."
          )
        );
        return;
      }

      const removed = await mutate((storage) =>
        removeContextualNoteOutboxEntry(
          storage,
          ownerId,
          entry!.clientKey,
          entry!.payloadHash
        )
      );
      if (!removed.ok) {
        await mutate(storage => markContextualNoteOutboxNeedsAttention(
          storage, ownerId, entry.clientKey, entry.payloadHash, removed.reason,
        ));
      }
    });
  } finally {
    activeSyncs.delete(activeKey);
  }
}
