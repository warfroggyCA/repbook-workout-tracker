import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { users } from "./user";
import { programs, programVersions, workoutTemplates } from "./program";
import { workoutSessions } from "./session";
import type { SessionCompilerInput, SessionCompilerOutput } from "@/lib/session-compiler";
import type { ProgramPreflightResult } from "@/lib/program-preflight";

export const sessionCompilerProposals = pgTable(
  "session_compiler_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    programId: uuid("program_id").notNull().references(() => programs.id, { onDelete: "cascade" }),
    programVersionId: uuid("program_version_id").notNull().references(() => programVersions.id, { onDelete: "cascade" }),
    workoutTemplateId: uuid("workout_template_id").notNull().references(() => workoutTemplates.id, { onDelete: "cascade" }),
    algorithmVersion: text("algorithm_version").notNull(),
    status: text("status").notNull().default("ready"),
    revision: integer("revision").notNull().default(1),
    inputSnapshot: jsonb("input_snapshot").$type<SessionCompilerInput>().notNull(),
    outputSnapshot: jsonb("output_snapshot").$type<SessionCompilerOutput>().notNull(),
    preflightSnapshot: jsonb("preflight_snapshot").$type<ProgramPreflightResult>().notNull(),
    contentHash: text("content_hash").notNull(),
    clientMutationId: text("client_mutation_id").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewHash: text("review_hash"),
    acceptedSessionId: uuid("accepted_session_id").references(() => workoutSessions.id, { onDelete: "cascade" }),
    acceptanceKey: text("acceptance_key"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("session_compiler_proposals_user_created_idx").on(t.userId, t.createdAt),
    uniqueIndex("session_compiler_proposals_user_mutation_uq").on(t.userId, t.clientMutationId),
    uniqueIndex("session_compiler_proposals_session_uq").on(t.acceptedSessionId).where(sql`${t.acceptedSessionId} IS NOT NULL`),
    uniqueIndex("session_compiler_proposals_acceptance_uq").on(t.userId, t.acceptanceKey).where(sql`${t.acceptanceKey} IS NOT NULL`),
    check("session_compiler_proposals_status_check", sql`${t.status} IN ('ready', 'accepted', 'discarded', 'stale', 'unable')`),
    check("session_compiler_proposals_revision_check", sql`${t.revision} = 1`),
    check("session_compiler_proposals_decision_check", sql`
      (${t.status} = 'accepted' AND ${t.acceptanceKey} IS NOT NULL AND ${t.acceptedAt} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.reviewHash} IS NOT NULL)
      OR (${t.status} <> 'accepted' AND ${t.acceptedSessionId} IS NULL AND ${t.acceptanceKey} IS NULL AND ${t.acceptedAt} IS NULL)
    `),
  ],
);
