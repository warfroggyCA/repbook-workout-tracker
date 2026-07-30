import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  exercises,
  programDrafts,
  programVersions,
  programs,
  recommendations,
} from "@/db/schema";
import {
  normalizeStoredProgramDocumentLoads,
  prepareProgramDocumentForEditing,
  projectIntentProgramDocumentV2,
  programDocumentV3Schema,
  storedProgramDocumentSchema,
  upgradeStoredProgramDocumentToV3,
  type ProgramDocumentV3,
} from "@/lib/program-document";
import { loadsEqual } from "@/lib/units";
import {
  programReviewSchema,
  type ProgramReview,
} from "@/lib/program-review-contract";
import {
  hashLegacyProgramDocument,
  hashProgramDocument,
} from "@/services/program-document-hash";
import {
  getOwnedProgramVersionDocument,
  listProgramVersionHistory,
  reviewProgramDocuments,
} from "@/services/program-documents";
import { loadProgramPreflightContext } from "@/services/program-preflight";
import { filterRecommendationsEligibleForAction } from "@/services/recommendation-evidence-eligibility";

export type ProgramDraftView = {
  id: string;
  revision: number;
  document: ProgramDocumentV3;
  reviewedRevision: number | null;
  reviewHash: string | null;
  reviewSummary: ProgramReview | null;
  reviewState:
    | { status: "none" }
    | { status: "current" }
    | { status: "expired"; reason: string };
};

export type ProgramDraftSaveResult =
  | { status: "saved"; revision: number }
  | { status: "conflict"; serverDraft: ProgramDraftView }
  | { status: "invalid"; errors: string[] };

function asDraftView(
  row: typeof programDrafts.$inferSelect,
  expiredReviewReason?: string,
): ProgramDraftView {
  const document = upgradeStoredProgramDocumentToV3(
    storedProgramDocumentSchema.parse(row.document),
  );
  const parsedReview = programReviewSchema.safeParse(row.reviewSummary);
  const reviewIsCurrent =
    parsedReview.success &&
    parsedReview.data.status === "publishable" &&
    parsedReview.data.reviewedRevision === row.revision &&
    row.reviewedRevision === parsedReview.data.reviewedRevision &&
    row.reviewHash === parsedReview.data.hash;
  const hasStoredReviewEvidence =
    row.reviewSummary != null ||
    row.reviewedRevision != null ||
    row.reviewHash != null;
  return {
    id: row.id,
    revision: row.revision,
    document,
    reviewedRevision: reviewIsCurrent ? row.reviewedRevision : null,
    reviewHash: reviewIsCurrent ? row.reviewHash : null,
    reviewSummary: reviewIsCurrent ? parsedReview.data : null,
    reviewState: expiredReviewReason
      ? { status: "expired", reason: expiredReviewReason }
      : reviewIsCurrent
        ? { status: "current" }
        : hasStoredReviewEvidence
          ? {
              status: "expired",
              reason:
                "The earlier review expired because its safety checks are no longer current.",
            }
          : { status: "none" },
  };
}

async function findOpenDraft(db: Db, userId: string, programId: string) {
  return db.query.programDrafts.findFirst({
    where: and(
      eq(programDrafts.userId, userId),
      eq(programDrafts.programId, programId),
      eq(programDrafts.status, "open")
    ),
  });
}

/**
 * Reconcile an open draft with the program's current version when
 * the active Program advanced after the draft was created (for example, when a
 * recommendation approval published a new version while the editor draft was
 * open). Without this the draft cannot be loaded, recreated, saved, or reviewed
 * — a persistent "Try reloading draft" dead-end that no retry can clear.
 *
 * Authored Program content is preserved. The row and embedded base identities,
 * checksum, revision, and mutation fence advance together, and only derived
 * review evidence is cleared. Immutable versions and workout history are
 * untouched.
 */
async function rebaseOpenDraftToCurrentVersion(
  db: Db,
  userId: string,
  draft: NonNullable<OpenDraftRow>,
  currentVersionId: string
): Promise<boolean> {
  const storedDocument = storedProgramDocumentSchema.parse(draft.document);
  const legacyContentHash = hashLegacyProgramDocument(storedDocument);
  const canonicalContentHash = hashProgramDocument(storedDocument);
  if (
    draft.contentHash !== legacyContentHash &&
    draft.contentHash !== canonicalContentHash
  ) {
    throw new Error("Program draft checksum does not match its document.");
  }
  if (storedDocument.programId !== draft.programId) {
    throw new Error("Program draft identity does not match its Program.");
  }
  const embeddedBase = await db.query.programVersions.findFirst({
    where: and(
      eq(programVersions.id, storedDocument.baseVersionId),
      eq(programVersions.programId, draft.programId),
    ),
    columns: { id: true },
  });
  if (!embeddedBase) {
    throw new Error("Program draft base version does not belong to its Program.");
  }
  const nextDocument = {
    ...(draft.document as Record<string, unknown>),
    baseVersionId: currentVersionId,
  };
  const nextContentHash = hashProgramDocument(nextDocument);
  const nextMutationId = randomUUID();
  const rows = resultRows(await db.execute(sql`
    UPDATE program_drafts draft
    SET base_version_id = ${currentVersionId}::uuid,
        document = ${JSON.stringify(nextDocument)}::jsonb,
        content_hash = ${nextContentHash},
        revision = draft.revision + 1,
        last_mutation_id = ${nextMutationId}::uuid,
        reviewed_revision = NULL,
        review_hash = NULL,
        review_summary = NULL,
        updated_at = now()
    FROM programs program
    WHERE draft.id = ${draft.id}::uuid
      AND draft.user_id = ${userId}::uuid
      AND draft.status = 'open'
      AND draft.program_id = ${draft.programId}::uuid
      AND draft.base_version_id = ${draft.baseVersionId}::uuid
      AND draft.revision = ${draft.revision}::int
      AND draft.content_hash = ${draft.contentHash}
      AND draft.document = ${JSON.stringify(draft.document)}::jsonb
      AND program.id = draft.program_id
      AND program.user_id = ${userId}::uuid
      AND program.status = 'active'
      AND program.archived_at IS NULL
      AND program.current_version_id = ${currentVersionId}::uuid
    RETURNING draft.id
  `));
  return rows.length === 1;
}

type OpenDraftRow = Awaited<ReturnType<typeof findOpenDraft>>;

async function reconcileOpenDraftBase(
  db: Db,
  userId: string,
  programId: string,
  currentVersionId: string
): Promise<{ draft: OpenDraftRow; baseAdvanced: boolean }> {
  const draft = await findOpenDraft(db, userId, programId);
  if (!draft) return { draft: undefined, baseAdvanced: false };
  const storedDocument = storedProgramDocumentSchema.parse(draft.document);
  if (
    draft.baseVersionId === currentVersionId &&
    storedDocument.baseVersionId === currentVersionId
  ) {
    return { draft, baseAdvanced: false };
  }
  const rebased = await rebaseOpenDraftToCurrentVersion(
    db,
    userId,
    draft,
    currentVersionId
  );
  if (!rebased) {
    const converged = await findOpenDraft(db, userId, programId);
    if (converged) {
      const convergedDocument = storedProgramDocumentSchema.parse(
        converged.document,
      );
      if (
        converged.baseVersionId === currentVersionId &&
        convergedDocument.baseVersionId === currentVersionId
      ) {
        return { draft: converged, baseAdvanced: true };
      }
    }
    // The Program advanced again concurrently; report no stable draft so the
    // caller can retry against the newest current version.
    return { draft: undefined, baseAdvanced: false };
  }
  return {
    draft: (await findOpenDraft(db, userId, programId)) ?? draft,
    baseAdvanced: true,
  };
}

export async function getOpenProgramDraft(db: Db, userId: string) {
  const program = await db.query.programs.findFirst({
    where: and(
      eq(programs.userId, userId),
      eq(programs.status, "active"),
      isNull(programs.archivedAt)
    ),
  });
  if (!program?.currentVersionId) return null;
  const reconciled = await reconcileOpenDraftBase(
    db,
    userId,
    program.id,
    program.currentVersionId
  );
  if (!reconciled.draft) return null;
  return {
    draft: asDraftView(
      reconciled.draft,
      reconciled.baseAdvanced
        ? "The active Program changed while this draft was open. Your edits were preserved, and a fresh review is required before activation."
        : undefined,
    ),
    history: await listProgramVersionHistory(db, userId, program.id),
    baseAdvanced: reconciled.baseAdvanced,
  };
}

export async function getOrCreateProgramDraft(db: Db, userId: string, attempt = 0) {
  const program = await db.query.programs.findFirst({
    where: and(
      eq(programs.userId, userId),
      eq(programs.status, "active"),
      isNull(programs.archivedAt)
    ),
  });
  if (!program?.currentVersionId) return null;
  let draft = await findOpenDraft(db, userId, program.id);
  if (!draft) {
    const sourceDocument = await getOwnedProgramVersionDocument(
      db,
      userId,
      program.currentVersionId
    );
    if (!sourceDocument) return null;
    const exerciseIds = [...new Set(sourceDocument.days.flatMap((day) =>
      day.exercises.map((slot) => slot.exerciseId),
    ))];
    const exerciseRows = exerciseIds.length
      ? await db.query.exercises.findMany({
          where: inArray(exercises.id, exerciseIds),
          columns: { id: true, name: true },
        })
      : [];
    const exerciseNames = new Map(exerciseRows.map((exercise) => [exercise.id, exercise.name]));
    const document = prepareProgramDocumentForEditing(
      sourceDocument,
      (exerciseId) => exerciseNames.get(exerciseId) ?? "Exercise",
    );
    const draftId = randomUUID();
    await db.execute(sql`
      INSERT INTO program_drafts (
        id, user_id, program_id, base_version_id, status, revision,
        document, content_hash, last_mutation_id
      )
      SELECT ${draftId}::uuid, ${userId}::uuid, current.id,
        current.current_version_id, 'open', 1,
        ${JSON.stringify(document)}::jsonb, ${hashProgramDocument(document)},
        ${randomUUID()}::uuid
      FROM programs current
      WHERE current.id = ${program.id}::uuid
        AND current.user_id = ${userId}::uuid
        AND current.status = 'active'
        AND current.archived_at IS NULL
        AND current.current_version_id = ${program.currentVersionId}::uuid
      ON CONFLICT (program_id) WHERE status = 'open' DO NOTHING
    `);
    draft = await findOpenDraft(db, userId, program.id);
  }
  if (!draft) throw new Error("The Program draft could not be created.");
  let baseAdvanced = false;
  if (draft.baseVersionId !== program.currentVersionId) {
    // The active Program advanced while this draft was open. Preserve the draft
    // and re-point it at the current version instead of dead-ending; only give
    // up if the program keeps moving under repeated concurrent activations.
    const reconciled = await reconcileOpenDraftBase(
      db,
      userId,
      program.id,
      program.currentVersionId
    );
    if (!reconciled.draft) {
      if (attempt >= 2) {
        throw new Error(
          "The Program changed while its draft was opening. Refresh and try again."
        );
      }
      return getOrCreateProgramDraft(db, userId, attempt + 1);
    }
    draft = reconciled.draft;
    baseAdvanced = reconciled.baseAdvanced;
  }
  return {
    draft: asDraftView(
      draft,
      baseAdvanced
        ? "The active Program changed while this draft was open. Your edits were preserved, and a fresh review is required before activation."
        : undefined,
    ),
    history: await listProgramVersionHistory(db, userId, program.id),
    baseAdvanced,
  };
}

async function validateExerciseOwnership(
  db: Db,
  userId: string,
  document: ProgramDocumentV3
) {
  const exerciseIds = [...new Set(document.days.flatMap((day) => day.exercises.map((slot) => slot.exerciseId)))];
  if (exerciseIds.length === 0) return false;
  const owned = await db.query.exercises.findMany({
    where: and(
      sql`${exercises.id} IN (${sql.join(exerciseIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
      or(isNull(exercises.userId), eq(exercises.userId, userId))
    ),
    columns: { id: true },
  });
  return owned.length === exerciseIds.length;
}

export async function saveProgramDraft(
  db: Db,
  userId: string,
  input: {
    draftId: string;
    expectedRevision: number;
    mutationId: string;
    document: unknown;
  }
): Promise<ProgramDraftSaveResult> {
  const parsed = programDocumentV3Schema.safeParse(input.document);
  if (!parsed.success) {
    return {
      status: "invalid",
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "Program"}: ${issue.message}`),
    };
  }
  const document = normalizeStoredProgramDocumentLoads(parsed.data) as ProgramDocumentV3;
  if (!(await validateExerciseOwnership(db, userId, document))) {
    return { status: "invalid", errors: ["One or more exercises are no longer available."] };
  }
  const contentHash = hashProgramDocument(document);
  const rows = resultRows(await db.execute(sql`
    WITH target AS MATERIALIZED (
      SELECT draft.*
      FROM program_drafts draft
      JOIN programs program ON program.id = draft.program_id
      WHERE draft.id = ${input.draftId}::uuid
        AND draft.user_id = ${userId}::uuid
        AND draft.status = 'open'
        AND draft.program_id = ${document.programId}::uuid
        AND draft.base_version_id = ${document.baseVersionId}::uuid
        AND program.user_id = ${userId}::uuid
        AND program.status = 'active'
        AND program.archived_at IS NULL
        AND program.current_version_id = draft.base_version_id
      FOR UPDATE
    ), replay AS (
      SELECT revision
      FROM target
      WHERE last_mutation_id = ${input.mutationId}::uuid
        AND content_hash = ${contentHash}
    ), saved AS (
      UPDATE program_drafts draft
      SET revision = draft.revision + 1,
          document = ${JSON.stringify(document)}::jsonb,
          content_hash = ${contentHash},
          last_mutation_id = ${input.mutationId}::uuid,
          reviewed_revision = NULL,
          review_hash = NULL,
          review_summary = NULL,
          updated_at = now()
      FROM target
      WHERE draft.id = target.id
        AND target.revision = ${input.expectedRevision}::int
        AND target.last_mutation_id <> ${input.mutationId}::uuid
      RETURNING draft.revision
    )
    SELECT revision::int, 'saved'::text AS result FROM saved
    UNION ALL
    SELECT revision::int, 'replay'::text AS result FROM replay
    LIMIT 1
  `));
  if (rows[0]) return { status: "saved", revision: Number(rows[0].revision) };
  const server = await db.query.programDrafts.findFirst({
    where: and(eq(programDrafts.id, input.draftId), eq(programDrafts.userId, userId)),
  });
  if (!server) return { status: "invalid", errors: ["This draft no longer exists."] };
  return { status: "conflict", serverDraft: asDraftView(server) };
}

export async function reviewProgramDraft(
  db: Db,
  userId: string,
  draftId: string,
  expectedRevision: number
) {
  const draft = await db.query.programDrafts.findFirst({
    where: and(
      eq(programDrafts.id, draftId),
      eq(programDrafts.userId, userId),
      eq(programDrafts.status, "open"),
      eq(programDrafts.revision, expectedRevision)
    ),
    with: { program: true },
  });
  if (
    !draft ||
    draft.program.status !== "active" ||
    draft.program.archivedAt ||
    draft.program.currentVersionId !== draft.baseVersionId
  ) return null;
  const base = await getOwnedProgramVersionDocument(db, userId, draft.baseVersionId);
  if (!base) return null;
  const parsedNext = programDocumentV3Schema.safeParse(draft.document);
  if (!parsedNext.success) {
    return reviewProgramDocuments(base, draft.document, draft.revision);
  }
  const legacyContentHash = hashLegacyProgramDocument(parsedNext.data);
  const next = normalizeStoredProgramDocumentLoads(parsedNext.data) as ProgramDocumentV3;
  const canonicalContentHash = hashProgramDocument(next);
  if (
    draft.contentHash !== legacyContentHash &&
    draft.contentHash !== canonicalContentHash
  ) {
    return null;
  }
  if (draft.contentHash !== canonicalContentHash) {
    const normalized = await db
      .update(programDrafts)
      .set({
        document: next,
        contentHash: canonicalContentHash,
        reviewedRevision: null,
        reviewHash: null,
        reviewSummary: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(programDrafts.id, draft.id),
          eq(programDrafts.userId, userId),
          eq(programDrafts.revision, draft.revision),
          eq(programDrafts.contentHash, draft.contentHash)
        )
      )
      .returning({ id: programDrafts.id });
    if (normalized.length !== 1) return null;
  }
  const exerciseIds = [...new Set(
    [...base.days, ...next.days].flatMap((day) => day.exercises.map((slot) => slot.exerciseId))
  )];
  const exerciseRows = exerciseIds.length
    ? await db.query.exercises.findMany({
        where: inArray(exercises.id, exerciseIds),
        columns: { id: true, name: true, primaryMuscles: true },
      })
    : [];
  const pending = await filterRecommendationsEligibleForAction(
    db,
    userId,
    await db.query.recommendations.findMany({
      where: and(
        eq(recommendations.userId, userId),
        eq(recommendations.status, "pending"),
        isNull(recommendations.archivedAt)
      ),
    }),
  );
  const baseSlots = new Map(base.days.flatMap((day) =>
    day.exercises.map((slot, slotIndex) => [slot.lineageId, { slot, slotIndex, day }] as const)
  ));
  const nextSlots = new Map(next.days.flatMap((day) =>
    day.exercises.map((slot, slotIndex) => [slot.lineageId, { slot, slotIndex, day }] as const)
  ));
  const recommendationConsequences = pending.map((recommendation) => {
    const previous = recommendation.sourceSlotLineageId
      ? baseSlots.get(recommendation.sourceSlotLineageId)
      : null;
    const current = recommendation.sourceSlotLineageId
      ? nextSlots.get(recommendation.sourceSlotLineageId)
      : null;
    const payload = recommendation.payload;
    if (payload.kind === "deload") {
      return { recommendationId: recommendation.id, outcome: "superseded" as const, explanation: "Publishing a newly reviewed Program version supersedes this Program-wide deload suggestion." };
    }
    if (!previous) {
      return { recommendationId: recommendation.id, outcome: "superseded" as const, explanation: "Its source exercise no longer matches the active Program." };
    }
    if (!current) {
      const currentDay = next.days.find((day) => day.lineageId === previous.day.lineageId);
      const replacement = currentDay?.exercises[previous.slotIndex];
      if (payload.kind === "substitution" && replacement?.exerciseId === payload.toExerciseId) {
        return { recommendationId: recommendation.id, outcome: "satisfied" as const, explanation: "The edited Program already uses the suggested replacement." };
      }
      return { recommendationId: recommendation.id, outcome: "superseded" as const, explanation: "The source exercise was removed or replaced, so this suggestion will expire." };
    }
    if (payload.kind === "load_change") {
      if (loadsEqual(current.slot.targetLoad, payload.toLoad) && current.slot.targetLoadUnit === payload.loadUnit) {
        return { recommendationId: recommendation.id, outcome: "satisfied" as const, explanation: "The edited target already matches this load suggestion." };
      }
      const baselineUnit = payload.fromLoad == null ? null : payload.loadUnit;
      const baselineMatches = loadsEqual(previous.slot.targetLoad, payload.fromLoad) &&
        previous.slot.targetLoadUnit === baselineUnit &&
        loadsEqual(current.slot.targetLoad, previous.slot.targetLoad) &&
        current.slot.targetLoadUnit === previous.slot.targetLoadUnit;
      return baselineMatches
        ? { recommendationId: recommendation.id, outcome: "carry" as const, explanation: "The same exercise and target remain, so this suggestion stays available." }
        : { recommendationId: recommendation.id, outcome: "superseded" as const, explanation: "The edited Program changes the target this suggestion expected." };
    }
    if (payload.kind === "substitution") {
      if (current.slot.exerciseId === payload.toExerciseId) {
        return { recommendationId: recommendation.id, outcome: "satisfied" as const, explanation: "The edited Program already uses the suggested exercise." };
      }
      return current.slot.exerciseId === payload.fromExerciseId
        ? { recommendationId: recommendation.id, outcome: "carry" as const, explanation: "The source exercise is unchanged, so this replacement suggestion stays available." }
        : { recommendationId: recommendation.id, outcome: "superseded" as const, explanation: "The source exercise changed, so this suggestion will expire." };
    }
    return { recommendationId: recommendation.id, outcome: "superseded" as const, explanation: "This suggestion will be reconciled with the new Program version." };
  });
  const review = reviewProgramDocuments(base, next, draft.revision, {
    recommendationRevision: draft.program.recommendationRevision,
    recommendationConsequences,
    exercises: Object.fromEntries(exerciseRows.map((exercise) => [exercise.id, {
      name: exercise.name,
      primaryMuscles: exercise.primaryMuscles,
    }])),
    editingBaseline: draft.restoredFromVersionId
      ? undefined
      : prepareProgramDocumentForEditing(
          base,
          (exerciseId) =>
            exerciseRows.find((exercise) => exercise.id === exerciseId)?.name ??
            "Exercise",
        ),
    preflightContext: await loadProgramPreflightContext(
      db,
      userId,
      projectIntentProgramDocumentV2(next),
    ),
  });
  if (review.status === "blocked") return review;
  const updated = await db.update(programDrafts).set({
    reviewedRevision: draft.revision,
    reviewHash: review.hash,
    reviewSummary: review,
    updatedAt: new Date(),
  }).where(and(
    eq(programDrafts.id, draft.id),
    eq(programDrafts.userId, userId),
    eq(programDrafts.revision, draft.revision),
    eq(programDrafts.contentHash, canonicalContentHash)
  )).returning({ id: programDrafts.id });
  return updated.length === 1 ? review : null;
}

export async function discardProgramDraft(
  db: Db,
  userId: string,
  draftId: string,
  expectedRevision: number
) {
  const rows = await db.update(programDrafts).set({
    status: "discarded",
    discardedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(programDrafts.id, draftId),
    eq(programDrafts.userId, userId),
    eq(programDrafts.status, "open"),
    eq(programDrafts.revision, expectedRevision)
  )).returning({ id: programDrafts.id });
  if (rows.length === 1) return { status: "discarded" as const };
  const existing = await db.query.programDrafts.findFirst({
    where: and(eq(programDrafts.id, draftId), eq(programDrafts.userId, userId)),
    columns: { status: true, revision: true },
  });
  if (existing?.status === "discarded" && existing.revision === expectedRevision) {
    return { status: "discarded" as const };
  }
  return { status: "conflict" as const };
}

export async function createRestoreProgramDraft(
  db: Db,
  userId: string,
  versionId: string,
  input: {
    currentDraftId: string;
    expectedRevision: number;
    mutationId: string;
  }
) {
  const historical = await getOwnedProgramVersionDocument(db, userId, versionId);
  if (!historical) return { status: "not_found" as const };
  const program = await db.query.programs.findFirst({
    where: and(
      eq(programs.id, historical.programId),
      eq(programs.userId, userId),
      eq(programs.status, "active"),
      isNull(programs.archivedAt)
    ),
  });
  if (!program?.currentVersionId) return { status: "not_found" as const };
  const replay = await getRestoreProgramDraftReplay(
    db,
    userId,
    versionId,
    input.mutationId
  );
  if (replay) return { status: "created" as const, draft: replay };
  const document = {
    ...upgradeStoredProgramDocumentToV3(historical),
    baseVersionId: program.currentVersionId,
  };
  const draftId = randomUUID();
  const rows = resultRows(await db.execute(sql`
    WITH current_program AS MATERIALIZED (
      SELECT program.id, program.current_version_id
      FROM programs program
      WHERE program.id = ${program.id}::uuid
        AND program.user_id = ${userId}::uuid
        AND program.status = 'active'
        AND program.archived_at IS NULL
        AND program.current_version_id = ${program.currentVersionId}::uuid
      FOR UPDATE
    ), discarded AS (
      UPDATE program_drafts draft
      SET status = 'discarded', discarded_at = now(), updated_at = now()
      FROM current_program program
      WHERE draft.program_id = program.id
        AND draft.user_id = ${userId}::uuid
        AND draft.status = 'open'
        AND draft.id = ${input.currentDraftId}::uuid
        AND draft.revision = ${input.expectedRevision}::int
      RETURNING draft.id
    ), inserted AS (
      INSERT INTO program_drafts (
        id, user_id, program_id, base_version_id,
        restored_from_version_id, document, content_hash, last_mutation_id
      )
      SELECT ${draftId}::uuid, ${userId}::uuid, program.id,
             program.current_version_id, ${versionId}::uuid,
             ${JSON.stringify(document)}::jsonb,
             ${hashProgramDocument(document)}, ${input.mutationId}::uuid
      FROM current_program program
      CROSS JOIN (SELECT count(*) AS count FROM discarded) prior
      WHERE prior.count = 1
      RETURNING *
    )
    SELECT id::text FROM inserted
  `));
  const inserted = rows[0];
  const draft = inserted
    ? await db.query.programDrafts.findFirst({
        where: and(eq(programDrafts.id, draftId), eq(programDrafts.userId, userId)),
      })
    : null;
  if (!draft) return { status: "conflict" as const };
  return { status: "created" as const, draft: asDraftView(draft) };
}

export async function getRestoreProgramDraftReplay(
  db: Db,
  userId: string,
  versionId: string,
  mutationId: string
): Promise<ProgramDraftView | null> {
  const replay = await db.query.programDrafts.findFirst({
    where: and(
      eq(programDrafts.userId, userId),
      eq(programDrafts.status, "open"),
      eq(programDrafts.restoredFromVersionId, versionId),
      eq(programDrafts.lastMutationId, mutationId)
    ),
    with: { program: true },
  });
  if (
    !replay ||
    replay.program.status !== "active" ||
    replay.program.archivedAt != null ||
    replay.program.currentVersionId !== replay.baseVersionId
  ) {
    return null;
  }
  return asDraftView(replay);
}
