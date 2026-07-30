import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./user";
import { archiveOperations } from "./archive";

export type SnapshotRecordCounts = Record<string, number>;

/** Metadata for an immutable encrypted object stored outside this database. */
export const dataSnapshots = pgTable(
  "data_snapshots",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    note: text("note"),
    reason: text("reason").notNull(),
    sourceOperationId: uuid("source_operation_id").references(
      () => archiveOperations.id,
      { onDelete: "set null" }
    ),
    status: text("status").notNull().default("creating"),
    objectPath: text("object_path").notNull(),
    objectEtag: text("object_etag"),
    appVersion: text("app_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    recordCounts: jsonb("record_counts")
      .$type<SnapshotRecordCounts>()
      .notNull(),
    plaintextChecksum: text("plaintext_checksum").notNull(),
    ciphertextChecksum: text("ciphertext_checksum"),
    encryptionAlgorithm: text("encryption_algorithm").notNull(),
    encryptionKeyVersion: text("encryption_key_version").notNull(),
    snapshotKind: text("snapshot_kind").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    failureReason: text("failure_reason"),
    deletionStatus: text("deletion_status"),
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
    deletionAttempts: integer("deletion_attempts").notNull().default(0),
    deletionFailureReason: text("deletion_failure_reason"),
    deletionLeaseId: uuid("deletion_lease_id"),
    deletionLeaseExpiresAt: timestamp("deletion_lease_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("data_snapshots_object_path_uq").on(t.objectPath),
    index("data_snapshots_user_created_idx").on(t.userId, t.createdAt),
    index("data_snapshots_user_status_idx").on(t.userId, t.status),
    index("data_snapshots_lifecycle_idx").on(
      t.snapshotKind,
      t.pinned,
      t.deletionStatus,
      t.createdAt
    ),
    index("data_snapshots_deletion_lease_idx").on(
      t.deletionStatus,
      t.deletionLeaseExpiresAt
    ),
    check(
      "data_snapshots_status_valid",
      sql`${t.status} in ('creating', 'verified', 'failed')`
    ),
    check("data_snapshots_size_nonnegative", sql`${t.sizeBytes} >= 0`),
    check(
      "data_snapshots_kind_valid",
      sql`${t.snapshotKind} in ('user', 'automatic')`
    ),
    check(
      "data_snapshots_deletion_status_valid",
      sql`${t.deletionStatus} is null or ${t.deletionStatus} in ('deleting', 'delete_failed')`
    ),
    check(
      "data_snapshots_deletion_attempts_nonnegative",
      sql`${t.deletionAttempts} >= 0`
    ),
    check(
      "data_snapshots_deletion_state_valid",
      sql`(
        ${t.deletionStatus} is null
        and ${t.deletionRequestedAt} is null
        and ${t.deletionFailureReason} is null
        and ${t.deletionLeaseId} is null
        and ${t.deletionLeaseExpiresAt} is null
      ) or (
        ${t.deletionStatus} = 'deleting'
        and ${t.deletionRequestedAt} is not null
        and ${t.deletionFailureReason} is null
        and ${t.deletionLeaseId} is not null
        and ${t.deletionLeaseExpiresAt} is not null
      ) or (
        ${t.deletionStatus} = 'delete_failed'
        and ${t.deletionRequestedAt} is not null
        and ${t.deletionFailureReason} is not null
        and ${t.deletionLeaseId} is null
        and ${t.deletionLeaseExpiresAt} is null
      )`
    ),
    check(
      "data_snapshots_retention_protection",
      sql`(${t.snapshotKind} = 'automatic' or ${t.deletionStatus} is null)
        and (not ${t.pinned} or ${t.deletionStatus} is null)`
    ),
  ]
);
