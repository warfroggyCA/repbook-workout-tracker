import {
  getContextualNoteOutboxSnapshot,
  removeContextualNote,
  subscribeToContextualNoteOutbox,
  type ContextualNoteOutboxSnapshot,
} from "@/lib/contextual-note-outbox";
import {
  getEquipmentSelectionOutboxSnapshot,
  removeEquipmentSelectionForOwner,
  subscribeToEquipmentSelectionOutbox,
  type EquipmentSelectionOutboxSnapshot,
} from "@/lib/equipment-selection-outbox";
import {
  getLiveCoachOutboxSnapshot,
  removeLiveCoachMessageForOwner,
  subscribeToLiveCoachOutbox,
  type LiveCoachOutboxSnapshot,
} from "@/lib/live-coach-outbox";
import {
  getOccurrenceMutationOutboxSnapshot,
  removeOccurrenceMutationForOwner,
  subscribeToOccurrenceMutationOutbox,
  type OccurrenceMutationOutboxSnapshot,
} from "@/lib/occurrence-mutation-outbox";
import {
  getWorkoutSetOutboxSnapshot,
  removeWorkoutSetForOwner,
  subscribeToWorkoutSetOutbox,
  type WorkoutSetOutboxSnapshot,
} from "@/lib/workout-set-outbox";

export const SIGN_OUT_DEVICE_STORE_KINDS = [
  "workout_sets",
  "occurrence_mutations",
  "equipment_selections",
  "contextual_notes",
  "live_coach",
] as const;

export type SignOutDeviceStoreKind =
  (typeof SIGN_OUT_DEVICE_STORE_KINDS)[number];

export type SignOutDeviceStoreInventory = {
  kind: SignOutDeviceStoreKind;
  label: string;
  queuedCount: number;
  syncingCount: number;
  needsAttentionCount: number;
  ownerEntryCount: number;
  foreignEntryCount: number;
  quarantinedCount: number;
  error: string | null;
};

export type SignOutDeviceWorkSnapshot = {
  ownerId: string;
  stores: readonly SignOutDeviceStoreInventory[];
  ownerEntryCount: number;
  quarantinedCount: number;
  errorCount: number;
  needsReview: boolean;
  canDiscardOwnerCopies: boolean;
};

export type SignOutDeviceWorkSources = {
  workoutSets: WorkoutSetOutboxSnapshot;
  occurrenceMutations: OccurrenceMutationOutboxSnapshot;
  equipmentSelections: EquipmentSelectionOutboxSnapshot;
  contextualNotes: ContextualNoteOutboxSnapshot;
  liveCoach: LiveCoachOutboxSnapshot;
};

type OwnerScopedEntry = {
  ownerId: string;
  status: "queued" | "syncing" | "needs_attention";
};

type StoreSource = {
  entries: readonly OwnerScopedEntry[];
  quarantined?: readonly unknown[];
  error: string | null;
};

function inventoryFor(
  kind: SignOutDeviceStoreKind,
  label: string,
  ownerId: string,
  source: StoreSource,
): SignOutDeviceStoreInventory {
  const owned = source.entries.filter((entry) => entry.ownerId === ownerId);
  return {
    kind,
    label,
    queuedCount: owned.filter((entry) => entry.status === "queued").length,
    syncingCount: owned.filter((entry) => entry.status === "syncing").length,
    needsAttentionCount: owned.filter(
      (entry) => entry.status === "needs_attention",
    ).length,
    ownerEntryCount: owned.length,
    foreignEntryCount: source.entries.length - owned.length,
    quarantinedCount: source.quarantined?.length ?? 0,
    error: source.error,
  };
}

export function buildSignOutDeviceWorkSnapshot(
  ownerId: string,
  sources: SignOutDeviceWorkSources,
): SignOutDeviceWorkSnapshot {
  const stores = [
    inventoryFor(
      "workout_sets",
      "Workout sets",
      ownerId,
      sources.workoutSets,
    ),
    inventoryFor(
      "occurrence_mutations",
      "Workout-item changes",
      ownerId,
      sources.occurrenceMutations,
    ),
    inventoryFor(
      "equipment_selections",
      "Equipment choices",
      ownerId,
      sources.equipmentSelections,
    ),
    inventoryFor(
      "contextual_notes",
      "Contextual notes",
      ownerId,
      sources.contextualNotes,
    ),
    inventoryFor(
      "live_coach",
      "Coach messages",
      ownerId,
      sources.liveCoach,
    ),
  ] satisfies SignOutDeviceStoreInventory[];
  const ownerEntryCount = stores.reduce(
    (total, store) => total + store.ownerEntryCount,
    0,
  );
  const quarantinedCount = stores.reduce(
    (total, store) => total + store.quarantinedCount,
    0,
  );
  const errorCount = stores.filter((store) => store.error != null).length;
  const hasUnsafeStore = quarantinedCount > 0 || errorCount > 0;

  return {
    ownerId,
    stores,
    ownerEntryCount,
    quarantinedCount,
    errorCount,
    needsReview: ownerEntryCount > 0 || hasUnsafeStore,
    canDiscardOwnerCopies: ownerEntryCount > 0 && !hasUnsafeStore,
  };
}

function countPhrase(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function describeSignOutDeviceStore(
  store: SignOutDeviceStoreInventory,
) {
  const details: string[] = [];
  if (store.queuedCount > 0) {
    details.push(
      countPhrase(
        store.queuedCount,
        "saved copy waiting or syncing",
        "saved copies waiting or syncing",
      ),
    );
  }
  if (store.syncingCount > 0) {
    details.push(countPhrase(store.syncingCount, "copy syncing", "copies syncing"));
  }
  if (store.needsAttentionCount > 0) {
    details.push(
      countPhrase(
        store.needsAttentionCount,
        "copy needing attention",
        "copies needing attention",
      ),
    );
  }
  if (store.quarantinedCount > 0) {
    details.push(
      countPhrase(
        store.quarantinedCount,
        "unreadable copy not safe for bulk discard",
        "unreadable copies not safe for bulk discard",
      ),
    );
  }
  if (store.error) details.push(store.error);
  if (details.length === 0) {
    return `${store.label}: no saved copies for this account.`;
  }
  return `${store.label}: ${details.join("; ")}.`;
}

export function readSignOutDeviceWorkSources(
  ownerId: string,
): SignOutDeviceWorkSources {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.getItem("__workout_tracker_sign_out_probe__");
    } catch {
      return {
        workoutSets: {
          entries: [],
          quarantined: [],
          error:
            "Saved device work could not be inspected. Stay signed in and restore browser storage access before trying again.",
        },
        occurrenceMutations: { entries: [], error: null },
        equipmentSelections: { entries: [], quarantined: [], error: null },
        contextualNotes: {
          ownerId,
          entries: [],
          quarantined: [],
          error: null,
        },
        liveCoach: { entries: [], quarantined: [], error: null },
      };
    }
  }
  return {
    workoutSets: getWorkoutSetOutboxSnapshot(),
    occurrenceMutations: getOccurrenceMutationOutboxSnapshot(),
    equipmentSelections: getEquipmentSelectionOutboxSnapshot(),
    contextualNotes: getContextualNoteOutboxSnapshot(ownerId),
    liveCoach: getLiveCoachOutboxSnapshot(),
  };
}

let cachedOwnerId: string | undefined;
let cachedSignature: string | undefined;
let cachedSnapshot: SignOutDeviceWorkSnapshot | undefined;

function inventorySignature(sources: SignOutDeviceWorkSources) {
  const sourceSignature = (source: StoreSource) => ({
    entries: source.entries.map((entry) => [entry.ownerId, entry.status]),
    quarantinedCount: source.quarantined?.length ?? 0,
    error: source.error,
  });
  return JSON.stringify([
    sourceSignature(sources.workoutSets),
    sourceSignature(sources.occurrenceMutations),
    sourceSignature(sources.equipmentSelections),
    sourceSignature(sources.contextualNotes),
    sourceSignature(sources.liveCoach),
  ]);
}

export function getSignOutDeviceWorkSnapshot(ownerId: string) {
  const sources = readSignOutDeviceWorkSources(ownerId);
  const signature = inventorySignature(sources);
  if (
    cachedOwnerId === ownerId &&
    cachedSnapshot &&
    cachedSignature === signature
  ) {
    return cachedSnapshot;
  }
  cachedOwnerId = ownerId;
  cachedSignature = signature;
  cachedSnapshot = buildSignOutDeviceWorkSnapshot(ownerId, sources);
  return cachedSnapshot;
}

const serverSnapshots = new Map<string, SignOutDeviceWorkSnapshot>();

export function getSignOutDeviceWorkServerSnapshot(ownerId: string) {
  const existing = serverSnapshots.get(ownerId);
  if (existing) return existing;
  const snapshot = buildSignOutDeviceWorkSnapshot(ownerId, {
    workoutSets: { entries: [], quarantined: [], error: null },
    occurrenceMutations: { entries: [], error: null },
    equipmentSelections: { entries: [], quarantined: [], error: null },
    contextualNotes: {
      ownerId,
      entries: [],
      quarantined: [],
      error: null,
    },
    liveCoach: { entries: [], quarantined: [], error: null },
  });
  serverSnapshots.set(ownerId, snapshot);
  return snapshot;
}

export function subscribeToSignOutDeviceWork(
  ownerId: string,
  onStoreChange: () => void,
) {
  const unsubscribe = [
    subscribeToWorkoutSetOutbox(onStoreChange),
    subscribeToOccurrenceMutationOutbox(onStoreChange),
    subscribeToEquipmentSelectionOutbox(onStoreChange),
    subscribeToContextualNoteOutbox(ownerId, onStoreChange),
    subscribeToLiveCoachOutbox(onStoreChange),
  ];
  return () => unsubscribe.forEach((stop) => stop());
}

type MutationResult = { ok: true } | { ok: false; reason: string };

export type SignOutDeviceWorkDiscardAdapter = {
  read: (ownerId: string) => SignOutDeviceWorkSources;
  discardWorkoutSet: (
    ownerId: string,
    clientKey: string,
  ) => Promise<MutationResult> | MutationResult;
  discardOccurrenceMutation: (
    ownerId: string,
    clientKey: string,
  ) => Promise<MutationResult> | MutationResult;
  discardContextualNote: (
    ownerId: string,
    clientKey: string,
    payloadHash: string,
  ) => Promise<MutationResult> | MutationResult;
  discardLiveCoachMessage: (
    ownerId: string,
    clientKey: string,
  ) => Promise<MutationResult> | MutationResult;
  discardEquipmentSelection: (
    ownerId: string,
    clientKey: string,
  ) => Promise<MutationResult> | MutationResult;
};

export type SignOutDeviceWorkDiscardResult =
  | { ok: true; snapshot: SignOutDeviceWorkSnapshot }
  | { ok: false; reason: string; snapshot: SignOutDeviceWorkSnapshot };

async function runDiscard(
  operation: () => Promise<MutationResult> | MutationResult,
  failedReason: string,
) {
  const result = await operation();
  if (result.ok) return null;
  return result.reason || failedReason;
}

function orderOwnedEquipmentSelections(
  ownerId: string,
  sources: SignOutDeviceWorkSources,
) {
  const owned = sources.equipmentSelections.entries.filter(
    (entry) => entry.ownerId === ownerId,
  );
  const ownedKeys = new Set(owned.map((entry) => entry.clientKey));
  const foreignSetDependency = sources.workoutSets.entries.some(
    (entry) =>
      entry.ownerId !== ownerId &&
      entry.equipmentSelectionClientKey != null &&
      ownedKeys.has(entry.equipmentSelectionClientKey),
  );
  const foreignSelectionDependency =
    sources.equipmentSelections.entries.some(
      (entry) =>
        entry.ownerId !== ownerId &&
        entry.predecessorSelectionClientKey != null &&
        ownedKeys.has(entry.predecessorSelectionClientKey),
    );
  if (foreignSetDependency || foreignSelectionDependency) {
    return {
      ok: false as const,
      reason:
        "Another account's saved work depends on this account's equipment choice. Keep the copies and review them after signing in again.",
    };
  }

  const remaining = new Map(owned.map((entry) => [entry.clientKey, entry]));
  const ordered: typeof owned = [];
  while (remaining.size > 0) {
    const leaves = [...remaining.values()]
      .filter(
        (candidate) =>
          ![...remaining.values()].some(
            (entry) =>
              entry.predecessorSelectionClientKey === candidate.clientKey,
          ),
      )
      .toSorted(
        (left, right) =>
          Date.parse(right.createdAtISO) - Date.parse(left.createdAtISO) ||
          right.clientKey.localeCompare(left.clientKey),
      );
    if (leaves.length === 0) {
      return {
        ok: false as const,
        reason:
          "The saved equipment choices contain an unsafe dependency cycle. Keep the copies and review them after signing in again.",
      };
    }
    for (const leaf of leaves) {
      ordered.push(leaf);
      remaining.delete(leaf.clientKey);
    }
  }
  return { ok: true as const, entries: ordered };
}

export async function discardSignOutDeviceWorkWithAdapter(
  ownerId: string,
  adapter: SignOutDeviceWorkDiscardAdapter,
): Promise<SignOutDeviceWorkDiscardResult> {
  const failed = (reason: string): SignOutDeviceWorkDiscardResult => ({
    ok: false,
    reason,
    snapshot: buildSignOutDeviceWorkSnapshot(ownerId, adapter.read(ownerId)),
  });
  const beforeSources = adapter.read(ownerId);
  const before = buildSignOutDeviceWorkSnapshot(ownerId, beforeSources);
  if (before.quarantinedCount > 0 || before.errorCount > 0) {
    return failed(
      "Some device copies cannot be attributed or read safely. Keep them and review them after signing in again.",
    );
  }
  if (before.ownerEntryCount === 0) {
    return { ok: true, snapshot: before };
  }
  const equipmentOrder = orderOwnedEquipmentSelections(ownerId, beforeSources);
  if (!equipmentOrder.ok) return failed(equipmentOrder.reason);

  for (const entry of beforeSources.workoutSets.entries) {
    if (entry.ownerId !== ownerId) continue;
    const reason = await runDiscard(
      () => adapter.discardWorkoutSet(ownerId, entry.clientKey),
      "A saved workout set could not be discarded.",
    );
    if (reason) return failed(reason);
  }

  for (const entry of beforeSources.occurrenceMutations.entries) {
    if (entry.ownerId !== ownerId) continue;
    const reason = await runDiscard(
      () => adapter.discardOccurrenceMutation(ownerId, entry.clientKey),
      "A saved workout-item change could not be discarded.",
    );
    if (reason) return failed(reason);
  }

  for (const entry of beforeSources.contextualNotes.entries) {
    if (entry.ownerId !== ownerId) continue;
    const reason = await runDiscard(
      () =>
        adapter.discardContextualNote(
          ownerId,
          entry.clientKey,
          entry.payloadHash,
        ),
      "A saved contextual note could not be discarded.",
    );
    if (reason) return failed(reason);
  }

  for (const entry of beforeSources.liveCoach.entries) {
    if (entry.ownerId !== ownerId) continue;
    const reason = await runDiscard(
      () => adapter.discardLiveCoachMessage(ownerId, entry.clientKey),
      "A saved Coach message could not be discarded.",
    );
    if (reason) return failed(reason);
  }

  for (const entry of equipmentOrder.entries) {
    const reason = await runDiscard(
      () => adapter.discardEquipmentSelection(ownerId, entry.clientKey),
      "A saved equipment choice could not be discarded.",
    );
    if (reason) return failed(reason);
  }

  const after = buildSignOutDeviceWorkSnapshot(
    ownerId,
    adapter.read(ownerId),
  );
  if (
    after.ownerEntryCount > 0 ||
    after.quarantinedCount > 0 ||
    after.errorCount > 0
  ) {
    return {
      ok: false,
      reason:
        "Device work changed while it was being discarded. Review the remaining copies before signing out.",
      snapshot: after,
    };
  }
  return { ok: true, snapshot: after };
}

export function discardSignOutDeviceWork(ownerId: string) {
  return discardSignOutDeviceWorkWithAdapter(ownerId, {
    read: readSignOutDeviceWorkSources,
    discardWorkoutSet: removeWorkoutSetForOwner,
    discardOccurrenceMutation: removeOccurrenceMutationForOwner,
    discardContextualNote: removeContextualNote,
    discardLiveCoachMessage: removeLiveCoachMessageForOwner,
    discardEquipmentSelection: removeEquipmentSelectionForOwner,
  });
}
