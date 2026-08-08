import { sql } from "drizzle-orm";
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
import { users } from "./user";

export type AnalysisPackageScope = {
  questionId: string;
  windowDays: number;
  windowStart: string;
  evidenceCutoff: string;
  timezone: string;
};

export type AnalysisPackageSourceBinding = {
  entity: string;
  ids: string[];
  revisions?: Array<{ id: string; revision: number }>;
};

export type AnalysisPackageInventory = {
  included: Record<string, number>;
  omitted: Array<{ category: string; reason: string; count?: number }>;
};

/**
 * Privacy-minimized receipt for an owner-generated external-analysis package.
 * The detailed package is previewed and downloaded by the owner but is never
 * retained here. Expiry is both an import trust boundary and the established
 * privacy-retention deletion boundary; owner deletion removes it sooner.
 */
export const analysisPackageManifests = pgTable(
  "analysis_package_manifests",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    packageNamespace: text("package_namespace").notNull(),
    schemaVersion: text("schema_version").notNull(),
    semanticVersion: text("semantic_version").notNull(),
    digestAlgorithm: text("digest_algorithm").notNull(),
    digest: text("digest").notNull(),
    scope: jsonb("scope").$type<AnalysisPackageScope>().notNull(),
    inventory: jsonb("inventory").$type<AnalysisPackageInventory>().notNull(),
    sourceBindings: jsonb("source_bindings")
      .$type<AnalysisPackageSourceBinding[]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    evidenceCutoff: timestamp("evidence_cutoff", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("analysis_package_manifests_owner_digest_uq").on(
      t.userId,
      t.digest,
    ),
    index("analysis_package_manifests_owner_expiry_idx").on(
      t.userId,
      t.expiresAt,
    ),
    check(
      "analysis_package_manifests_schema_check",
      sql`${t.schemaVersion} = 'analysis-package/1' AND ${t.semanticVersion} = 'repbook-v2/1'`,
    ),
    check(
      "analysis_package_manifests_digest_check",
      sql`${t.packageNamespace} ~ '^repbook-owner/[0-9a-f]{24}$' AND ${t.digestAlgorithm} = 'sha256' AND ${t.digest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "analysis_package_manifests_shape_check",
      sql`jsonb_typeof(${t.scope}) = 'object' AND jsonb_typeof(${t.inventory}) = 'object' AND jsonb_typeof(${t.inventory}->'included') = 'object' AND jsonb_typeof(${t.inventory}->'omitted') = 'array' AND jsonb_typeof(${t.sourceBindings}) = 'array'`,
    ),
    check(
      "analysis_package_manifests_retention_check",
      sql`${t.evidenceCutoff} <= ${t.createdAt} AND ${t.createdAt} < ${t.expiresAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '30 days'`,
    ),
  ],
);
