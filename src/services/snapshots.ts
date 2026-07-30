import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { dataSnapshots } from "@/db/schema";
import {
  canonicalJson,
  decryptSnapshotBytes,
  encryptSnapshotBytes,
  parseSnapshotKey,
  sha256Hex,
  SNAPSHOT_ENCRYPTION_ALGORITHM,
} from "@/services/snapshot-crypto";
import {
  captureUserSnapshot,
  snapshotRecordCounts,
  SNAPSHOT_SCHEMA_VERSION,
  type CanonicalSnapshotPayload,
} from "@/services/snapshot-capture";
import {
  getSnapshotObjectStore,
  type SnapshotObjectStore,
} from "@/services/snapshot-store";

export type SnapshotKeyring = {
  currentVersion: string;
  resolve(version: string): Uint8Array;
};

export type CreateSnapshotInput = {
  name: string;
  note?: string | null;
  reason: string;
  sourceOperationId?: string | null;
  pinned?: boolean;
  snapshotKind?: "user" | "automatic";
};

export type SnapshotActionFailureCode =
  | "snapshot_input_invalid"
  | "snapshot_configuration_failed"
  | "snapshot_capture_failed"
  | "snapshot_serialization_failed"
  | "snapshot_payload_too_large"
  | "snapshot_encryption_failed"
  | "snapshot_metadata_failed"
  | "snapshot_verification_failed";

export type SnapshotActionResult =
  | { ok: true; snapshotId: string; verifiedAt: Date }
  | {
      ok: false;
      reason: string;
      code: SnapshotActionFailureCode;
    };

// The complete canonical JSON string still exists in memory. Once measured, a
// 64 MiB plaintext ceiling refuses the capture before Buffer allocation and
// base64/encryption overhead can amplify that memory use.
export const SNAPSHOT_SERIALIZED_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export type SnapshotDependencies = {
  store?: SnapshotObjectStore;
  keyring?: SnapshotKeyring;
  now?: Date;
  appVersion?: string;
  /** Test-only seam. It may tighten, but never relax, the production ceiling. */
  testSerializedSizeLimitBytes?: number;
};

export function resolveSnapshotAppVersion(
  explicit: string | undefined,
  environment: Record<string, string | undefined> = process.env
) {
  return (
    [
      explicit,
      environment.VERCEL_GIT_COMMIT_SHA,
      environment.npm_package_version,
    ]
      .map((value) => value?.trim())
      .find((value): value is string => Boolean(value)) ?? "development"
  );
}

function envNameForKeyVersion(version: string) {
  if (!/^[a-z0-9_-]+$/i.test(version)) {
    throw new Error("Snapshot encryption key version is invalid.");
  }
  return `SNAPSHOT_ENCRYPTION_KEY_${version.toUpperCase().replaceAll("-", "_")}`;
}

export function getSnapshotKeyring(): SnapshotKeyring {
  const currentVersion = process.env.SNAPSHOT_ENCRYPTION_KEY_VERSION?.trim() || "v1";
  return {
    currentVersion,
    resolve(version: string) {
      const encoded = process.env[envNameForKeyVersion(version)];
      if (!encoded) throw new Error(`Snapshot encryption key ${version} is unavailable.`);
      return parseSnapshotKey(encoded);
    },
  };
}

function normalizeName(value: string) {
  const name = value.trim();
  if (!name || name.length > 120) {
    throw new Error("Snapshot name must be between 1 and 120 characters.");
  }
  return name;
}

function normalizeNote(value: string | null | undefined) {
  const note = value?.trim() || null;
  if (note && note.length > 1000) {
    throw new Error("Snapshot note must be 1,000 characters or fewer.");
  }
  return note;
}

function normalizedError(error: unknown) {
  const message =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : "Snapshot verification failed.";
  return message.slice(0, 500);
}

function resolveSerializedSizeLimit(injectedLimit: number | undefined) {
  if (injectedLimit === undefined) {
    return SNAPSHOT_SERIALIZED_SIZE_LIMIT_BYTES;
  }
  if (
    !Number.isSafeInteger(injectedLimit) ||
    injectedLimit <= 0 ||
    injectedLimit > SNAPSHOT_SERIALIZED_SIZE_LIMIT_BYTES
  ) {
    throw new Error(
      `The snapshot test size limit must be a positive integer no larger than ${SNAPSHOT_SERIALIZED_SIZE_LIMIT_BYTES} bytes.`
    );
  }
  return injectedLimit;
}

function countsMatch(
  expected: Record<string, number>,
  actual: Record<string, number>
) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys].every((key) => expected[key] === actual[key]);
}

export async function createDataSnapshot(
  db: Db,
  userId: string,
  input: CreateSnapshotInput,
  dependencies: SnapshotDependencies = {}
): Promise<SnapshotActionResult> {
  let name: string;
  let note: string | null;
  try {
    name = normalizeName(input.name);
    note = normalizeNote(input.note);
  } catch (error) {
    return {
      ok: false,
      reason: normalizedError(error),
      code: "snapshot_input_invalid",
    };
  }

  const now = dependencies.now ?? new Date();
  const appVersion = resolveSnapshotAppVersion(dependencies.appVersion);
  let store: SnapshotObjectStore;
  let keyring: SnapshotKeyring;
  let serializedSizeLimitBytes: number;
  try {
    store = dependencies.store ?? getSnapshotObjectStore();
    keyring = dependencies.keyring ?? getSnapshotKeyring();
    serializedSizeLimitBytes = resolveSerializedSizeLimit(
      dependencies.testSerializedSizeLimitBytes
    );
  } catch (error) {
    return {
      ok: false,
      reason: normalizedError(error),
      code: "snapshot_configuration_failed",
    };
  }

  const snapshotId = randomUUID();
  const objectPath = `snapshots/${userId}/${snapshotId}.wtbk`;
  let payload: CanonicalSnapshotPayload;
  try {
    payload = await captureUserSnapshot(db, userId, now, appVersion);
  } catch (error) {
    return {
      ok: false,
      reason: normalizedError(error),
      code: "snapshot_capture_failed",
    };
  }

  let serialized: string;
  let serializedSizeBytes: number;
  try {
    serialized = canonicalJson(payload);
    serializedSizeBytes = Buffer.byteLength(serialized, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: normalizedError(error),
      code: "snapshot_serialization_failed",
    };
  }
  if (serializedSizeBytes > serializedSizeLimitBytes) {
    return {
      ok: false,
      reason:
        "This snapshot is too large to create safely. Its saved data exceeds the 64 MiB limit.",
      code: "snapshot_payload_too_large",
    };
  }

  let plaintext: Buffer;
  let counts: Record<string, number>;
  let plaintextChecksum: string;
  try {
    plaintext = Buffer.from(serialized, "utf8");
    counts = snapshotRecordCounts(payload);
    plaintextChecksum = sha256Hex(plaintext);
  } catch (error) {
    return {
      ok: false,
      reason: normalizedError(error),
      code: "snapshot_serialization_failed",
    };
  }

  let encrypted: Uint8Array;
  try {
    encrypted = encryptSnapshotBytes(
      plaintext,
      keyring.resolve(keyring.currentVersion),
      keyring.currentVersion
    );
  } catch (error) {
    return {
      ok: false,
      reason: normalizedError(error),
      code: "snapshot_encryption_failed",
    };
  }

  try {
    await db.insert(dataSnapshots).values({
      id: snapshotId,
      userId,
      name,
      note,
      reason: input.reason,
      sourceOperationId: input.sourceOperationId ?? null,
      status: "creating",
      objectPath,
      appVersion,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sizeBytes: encrypted.length,
      recordCounts: counts,
      plaintextChecksum,
      encryptionAlgorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
      encryptionKeyVersion: keyring.currentVersion,
      snapshotKind: input.snapshotKind ?? "user",
      pinned: input.pinned ?? false,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    return {
      ok: false,
      reason: normalizedError(error),
      code: "snapshot_metadata_failed",
    };
  }

  try {
    const stored = await store.put(objectPath, encrypted);
    if (stored.pathname !== objectPath || stored.size !== encrypted.length) {
      throw new Error("Stored snapshot metadata did not match the uploaded object.");
    }
    const readBack = await store.get(objectPath);
    const ciphertextChecksum = sha256Hex(readBack);
    if (ciphertextChecksum !== sha256Hex(encrypted)) {
      throw new Error("Stored snapshot checksum did not match the uploaded copy.");
    }
    const decrypted = decryptSnapshotBytes(readBack, (version) => keyring.resolve(version));
    if (decrypted.keyVersion !== keyring.currentVersion) {
      throw new Error("Stored snapshot key version did not match its metadata.");
    }
    if (sha256Hex(decrypted.plaintext) !== plaintextChecksum) {
      throw new Error("Stored snapshot plaintext checksum did not match.");
    }
    const verifiedPayload = JSON.parse(
      Buffer.from(decrypted.plaintext).toString("utf8")
    ) as CanonicalSnapshotPayload;
    if (!countsMatch(counts, snapshotRecordCounts(verifiedPayload))) {
      throw new Error("Stored snapshot record counts did not match.");
    }

    const verifiedAt = new Date();
    const verifiedQuery = sql`
      WITH updated AS (
        UPDATE data_snapshots
        SET status = 'verified',
            object_etag = ${stored.etag},
            ciphertext_checksum = ${ciphertextChecksum},
            verified_at = ${verifiedAt.toISOString()}::timestamptz,
            failure_reason = NULL,
            updated_at = ${verifiedAt.toISOString()}::timestamptz
        WHERE id = ${snapshotId}::uuid
          AND user_id = ${userId}::uuid
          AND status = 'creating'
        RETURNING id, name
      ), audit AS (
        INSERT INTO audit_logs (
          user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
        )
        SELECT
          ${userId}::uuid,
          'user',
          'snapshot.verify',
          'data_snapshot',
          id::text,
          'Created and verified encrypted snapshot ' || name,
          jsonb_build_object('reason', ${input.reason}::text, 'recordCounts', ${JSON.stringify(counts)}::jsonb)
        FROM updated
      )
      SELECT id FROM updated
    `;
    if (!resultRows(await db.execute(verifiedQuery))[0]) {
      throw new Error("Snapshot verification status could not be saved.");
    }
    return { ok: true, snapshotId, verifiedAt };
  } catch (error) {
    const failureReason = normalizedError(error);
    await db
      .update(dataSnapshots)
      .set({ status: "failed", failureReason, updatedAt: new Date() })
      .where(
        and(
          eq(dataSnapshots.id, snapshotId),
          eq(dataSnapshots.userId, userId),
          eq(dataSnapshots.status, "creating")
        )
      );
    return {
      ok: false,
      reason: failureReason,
      code: "snapshot_verification_failed",
    };
  }
}

export async function listDataSnapshots(
  db: Db,
  userId: string,
  search?: string
) {
  const query = search?.trim();
  return db.query.dataSnapshots.findMany({
    where: and(
      eq(dataSnapshots.userId, userId),
      isNull(dataSnapshots.deletionStatus),
      ...(query
        ? [
            or(
              ilike(dataSnapshots.name, `%${query}%`),
              ilike(dataSnapshots.note, `%${query}%`)
            ),
          ]
        : [])
    ),
    orderBy: desc(dataSnapshots.createdAt),
    limit: 100,
  });
}

export async function updateDataSnapshotMetadata(
  db: Db,
  userId: string,
  snapshotId: string,
  input: { name: string; note?: string | null; pinned: boolean }
) {
  let name: string;
  let note: string | null;
  try {
    name = normalizeName(input.name);
    note = normalizeNote(input.note);
  } catch (error) {
    return { ok: false as const, reason: normalizedError(error) };
  }
  const query = sql`
    WITH updated AS (
      UPDATE data_snapshots
      SET name = ${name},
          note = ${note},
          pinned = ${input.pinned},
          updated_at = now()
      WHERE id = ${snapshotId}::uuid
        AND user_id = ${userId}::uuid
        AND deletion_status IS NULL
      RETURNING id, name
    ), audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        'snapshot.metadata_update',
        'data_snapshot',
        id::text,
        'Updated snapshot name, note, or pin status for ' || name,
        jsonb_build_object('pinned', ${input.pinned}::boolean)
      FROM updated
    )
    SELECT id FROM updated
  `;
  return resultRows(await db.execute(query))[0]
    ? { ok: true as const }
    : { ok: false as const, reason: "Snapshot was not found." };
}

export async function readVerifiedDataSnapshot(
  db: Db,
  userId: string,
  snapshotId: string,
  dependencies: Pick<SnapshotDependencies, "store" | "keyring"> = {}
) {
  const snapshot = await db.query.dataSnapshots.findFirst({
    where: and(
      eq(dataSnapshots.id, snapshotId),
      eq(dataSnapshots.userId, userId),
      eq(dataSnapshots.status, "verified"),
      isNull(dataSnapshots.deletionStatus)
    ),
  });
  if (!snapshot) throw new Error("Verified snapshot was not found.");
  const store = dependencies.store ?? getSnapshotObjectStore();
  const keyring = dependencies.keyring ?? getSnapshotKeyring();
  const encrypted = await store.get(snapshot.objectPath);
  if (sha256Hex(encrypted) !== snapshot.ciphertextChecksum) {
    throw new Error("Snapshot object checksum no longer matches.");
  }
  const decrypted = decryptSnapshotBytes(encrypted, (version) => keyring.resolve(version));
  if (
    decrypted.keyVersion !== snapshot.encryptionKeyVersion ||
    sha256Hex(decrypted.plaintext) !== snapshot.plaintextChecksum
  ) {
    throw new Error("Snapshot plaintext verification failed.");
  }
  const payload = JSON.parse(
    Buffer.from(decrypted.plaintext).toString("utf8")
  ) as CanonicalSnapshotPayload;
  if (!countsMatch(snapshot.recordCounts, snapshotRecordCounts(payload))) {
    throw new Error("Snapshot record counts no longer match.");
  }
  return { snapshot, payload, plaintext: decrypted.plaintext };
}

export function defaultSnapshotName(now = new Date()) {
  return `Snapshot ${new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Toronto",
  }).format(now)}`;
}

export async function createAutomaticSafetySnapshot(
  db: Db,
  userId: string,
  reason: string,
  note: string,
  dependencies: SnapshotDependencies = {}
) {
  const now = dependencies.now ?? new Date();
  return createDataSnapshot(
    db,
    userId,
    {
      name: `Safety snapshot · ${reason} · ${new Intl.DateTimeFormat("en-CA", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/Toronto",
      }).format(now)}`,
      note,
      reason,
      pinned: false,
      snapshotKind: "automatic",
    },
    { ...dependencies, now }
  );
}
