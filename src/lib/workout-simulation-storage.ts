import {
  SIMULATION_WORKSPACE_VERSION,
  simulationWorkspaceSchema,
  type SimulationWorkspace,
} from "@/lib/workout-simulation";

export const SIMULATION_STORAGE_PREFIX = "workout-tracker:simulation:v1:";
export const SIMULATION_MAX_WORKSPACES_PER_OWNER = 3;
export const SIMULATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const SIMULATION_MAX_SERIALIZED_BYTES = 1_000_000;

export type SimulationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "length" | "key">>;

type ReadError =
  | "missing"
  | "malformed"
  | "future_version"
  | "wrong_owner"
  | "wrong_identity"
  | "storage_error";

type ReadResult =
  | { workspace: SimulationWorkspace; error: null }
  | { workspace: null; error: ReadError };

type ParsedCopy =
  | { workspace: SimulationWorkspace; error: null }
  | { workspace: null; error: "malformed" | "future_version" };

function safePart(value: string) {
  return encodeURIComponent(value);
}

function serializedByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function simulationStorageKey(ownerId: string, simulationId: string) {
  return `${SIMULATION_STORAGE_PREFIX}${safePart(ownerId)}:${safePart(simulationId)}`;
}

function parseCopy(raw: string): ParsedCopy {
  if (serializedByteLength(raw) > SIMULATION_MAX_SERIALIZED_BYTES) {
    return { workspace: null, error: "malformed" };
  }

  try {
    const decoded: unknown = JSON.parse(raw);
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "version" in decoded &&
      typeof decoded.version === "number" &&
      decoded.version > SIMULATION_WORKSPACE_VERSION
    ) {
      return { workspace: null, error: "future_version" };
    }

    const parsed = simulationWorkspaceSchema.safeParse(decoded);
    return parsed.success
      ? { workspace: parsed.data, error: null }
      : { workspace: null, error: "malformed" };
  } catch {
    return { workspace: null, error: "malformed" };
  }
}

function removeAndVerify(storage: SimulationStorage, key: string) {
  try {
    storage.removeItem(key);
    return storage.getItem(key) == null;
  } catch {
    return false;
  }
}

function quarantineUnreadableCopy(storage: SimulationStorage, key: string): ReadError {
  return removeAndVerify(storage, key) ? "malformed" : "storage_error";
}

export function readSimulationWorkspace(
  storage: SimulationStorage,
  ownerId: string,
  simulationId: string,
): ReadResult {
  const key = simulationStorageKey(ownerId, simulationId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { workspace: null, error: "storage_error" };
  }
  if (raw == null) return { workspace: null, error: "missing" };

  const parsed = parseCopy(raw);
  if (!parsed.workspace) {
    if (parsed.error === "future_version") {
      // A newer app may still understand this copy. Hide it without deleting it.
      return { workspace: null, error: "future_version" };
    }
    return { workspace: null, error: quarantineUnreadableCopy(storage, key) };
  }
  if (parsed.workspace.ownerId !== ownerId) {
    const removed = removeAndVerify(storage, key);
    return { workspace: null, error: removed ? "wrong_owner" : "storage_error" };
  }
  if (
    parsed.workspace.simulationId !== simulationId ||
    simulationStorageKey(ownerId, parsed.workspace.simulationId) !== key
  ) {
    const removed = removeAndVerify(storage, key);
    return { workspace: null, error: removed ? "wrong_identity" : "storage_error" };
  }
  return { workspace: parsed.workspace, error: null };
}

export function writeSimulationWorkspace(
  storage: SimulationStorage,
  workspace: SimulationWorkspace,
):
  | { ok: true }
  | { ok: false; reason: "invalid" | "too_large" | "storage_error" | "limit" } {
  const parsed = simulationWorkspaceSchema.safeParse(workspace);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const serialized = JSON.stringify(parsed.data);
  if (serializedByteLength(serialized) > SIMULATION_MAX_SERIALIZED_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  const key = simulationStorageKey(workspace.ownerId, workspace.simulationId);
  let previous: string | null | undefined;
  try {
    previous = storage.getItem(key);
    if (
      previous == null &&
      listSimulationWorkspaces(storage, workspace.ownerId).length >=
        SIMULATION_MAX_WORKSPACES_PER_OWNER
    ) {
      return { ok: false, reason: "limit" };
    }
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) {
      if (previous == null) storage.removeItem(key);
      else storage.setItem(key, previous);
      return { ok: false, reason: "storage_error" };
    }
    return { ok: true };
  } catch {
    try {
      if (previous === undefined) {
        // The initial read failed, so no safe rollback value exists.
      } else if (previous == null) {
        storage.removeItem(key);
      } else {
        storage.setItem(key, previous);
      }
    } catch {
      // The caller still receives failure and must retain its prior visible state.
    }
    return { ok: false, reason: "storage_error" };
  }
}

export function updateStoredSimulationWorkspace(
  storage: SimulationStorage,
  ownerId: string,
  simulationId: string,
  expectedRevision: number,
  mutate: (workspace: SimulationWorkspace) => SimulationWorkspace,
):
  | { ok: true; workspace: SimulationWorkspace }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "stale"
        | "invalid"
        | "too_large"
        | "storage_error"
        | "limit";
    } {
  const current = readSimulationWorkspace(storage, ownerId, simulationId);
  if (!current.workspace) {
    if (current.error === "missing") return { ok: false, reason: "missing" };
    if (current.error === "storage_error") return { ok: false, reason: "storage_error" };
    return { ok: false, reason: "malformed" };
  }
  if (current.workspace.revision !== expectedRevision) {
    return { ok: false, reason: "stale" };
  }

  let candidate: SimulationWorkspace;
  try {
    candidate = simulationWorkspaceSchema.parse({
      ...mutate(current.workspace),
      ownerId,
      simulationId,
      revision: current.workspace.revision + 1,
    });
  } catch {
    return { ok: false, reason: "invalid" };
  }

  // Re-read after the mutation callback so a stale browser copy cannot overwrite
  // a newer revision, even when the storage implementation changes synchronously.
  const latest = readSimulationWorkspace(storage, ownerId, simulationId);
  if (!latest.workspace) {
    if (latest.error === "missing") return { ok: false, reason: "missing" };
    if (latest.error === "storage_error") return { ok: false, reason: "storage_error" };
    return { ok: false, reason: "malformed" };
  }
  if (latest.workspace.revision !== expectedRevision) {
    return { ok: false, reason: "stale" };
  }

  const written = writeSimulationWorkspace(storage, candidate);
  if (!written.ok) return written;
  return { ok: true, workspace: candidate };
}

function storageKeys(storage: SimulationStorage) {
  const keys: string[] = [];
  try {
    if (typeof storage.length !== "number" || typeof storage.key !== "function") {
      return keys;
    }
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

export function listSimulationWorkspaces(
  storage: SimulationStorage,
  ownerId: string,
  nowMs = Date.now(),
) {
  const prefix = `${SIMULATION_STORAGE_PREFIX}${safePart(ownerId)}:`;
  const workspaces: SimulationWorkspace[] = [];

  for (const key of storageKeys(storage).filter((candidate) => candidate.startsWith(prefix))) {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      continue;
    }
    if (raw == null) continue;

    const parsed = parseCopy(raw);
    if (!parsed.workspace) {
      if (parsed.error === "malformed") removeAndVerify(storage, key);
      continue;
    }
    if (
      parsed.workspace.ownerId !== ownerId ||
      simulationStorageKey(ownerId, parsed.workspace.simulationId) !== key
    ) {
      removeAndVerify(storage, key);
      continue;
    }

    const updated = Date.parse(parsed.workspace.updatedAtISO);
    if (!Number.isFinite(updated) || nowMs - updated > SIMULATION_RETENTION_MS) {
      removeAndVerify(storage, key);
      continue;
    }
    workspaces.push(parsed.workspace);
  }

  workspaces.sort((left, right) => right.updatedAtISO.localeCompare(left.updatedAtISO));
  for (const excess of workspaces.slice(SIMULATION_MAX_WORKSPACES_PER_OWNER)) {
    removeAndVerify(storage, simulationStorageKey(ownerId, excess.simulationId));
  }
  return workspaces.slice(0, SIMULATION_MAX_WORKSPACES_PER_OWNER);
}

export function canCreateSimulationWorkspace(
  storage: SimulationStorage,
  ownerId: string,
  nowMs = Date.now(),
) {
  return (
    listSimulationWorkspaces(storage, ownerId, nowMs).length <
    SIMULATION_MAX_WORKSPACES_PER_OWNER
  );
}

export function resetSimulationWorkspace(
  storage: SimulationStorage,
  ownerId: string,
  simulationId: string,
): { ok: true } | { ok: false; reason: "storage_error" } {
  return removeAndVerify(storage, simulationStorageKey(ownerId, simulationId))
    ? { ok: true }
    : { ok: false, reason: "storage_error" };
}
