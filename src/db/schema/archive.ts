import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./user";

export type ArchiveRecordCounts = Record<string, number>;

/** One user-confirmed archive action, including a bulk action and its Undo. */
export const archiveOperations = pgTable(
  "archive_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    status: text("status").notNull().default("active"),
    summary: text("summary").notNull(),
    recordCounts: jsonb("record_counts")
      .$type<ArchiveRecordCounts>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("archive_operations_user_created_idx").on(t.userId, t.createdAt),
    index("archive_operations_user_status_idx").on(t.userId, t.status),
  ]
);

export type PermanentDeletePreviewData = {
  operationId: string;
  rootType: string;
  summary: string;
  deleteCounts: Record<string, number>;
  preservedCounts: Record<string, number>;
  blockers: Array<{ key: string; message: string; count: number }>;
};

/** Short-lived bearer grants created only after a new provider identity check. */
export const permanentDeleteGrants = pgTable(
  "permanent_delete_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => archiveOperations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose").notNull().default("archive.permanent_delete"),
    provider: text("provider").notNull(),
    preview: jsonb("preview").$type<PermanentDeletePreviewData>().notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("permanent_delete_grants_token_hash_uq").on(t.tokenHash),
    index("permanent_delete_grants_user_operation_idx").on(
      t.userId,
      t.operationId,
      t.expiresAt
    ),
    check(
      "permanent_delete_grants_purpose_valid",
      sql`${t.purpose} = 'archive.permanent_delete'`
    ),
    check(
      "permanent_delete_grants_provider_valid",
      sql`${t.provider} in ('github', 'dev-login')`
    ),
    check(
      "permanent_delete_grants_expiry_valid",
      sql`${t.expiresAt} > ${t.requestedAt}`
    ),
  ]
);

/** Immutable membership used for exact counts, restore, and nested archives. */
export const archiveOperationRecords = pgTable(
  "archive_operation_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => archiveOperations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    relationshipRole: text("relationship_role").notNull().default("root"),
    parentEntityType: text("parent_entity_type"),
    parentEntityId: text("parent_entity_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("archive_operation_records_member_uq").on(
      t.operationId,
      t.entityType,
      t.entityId
    ),
    index("archive_operation_records_entity_idx").on(
      t.userId,
      t.entityType,
      t.entityId
    ),
  ]
);
