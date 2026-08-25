"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { buildProgramRoutineDraft } from "@/app/actions/setup";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import {
  addProgramExerciseToDay,
  appendProgramDocumentDay,
  moveProgramSlotToDay as moveProgramSlotToDayDocument,
  parseProgramReviewResponse,
  programEditorResponseJson as responseJson,
  programEditorSafeFilePart,
  removeProgramSlotFromDay,
  updateProgramDocumentDay,
  type ProgramHistoryEntry,
  type ProgramReview,
} from "@/lib/program-editor-client";
import {
  programDocumentV3Schema,
  projectIntentProgramDocumentV2,
  storedProgramDocumentSchema,
  type ProgramDocumentV3,
  type ProgramDocumentDayV3,
  type StoredProgramDocument,
} from "@/lib/program-document";
import { buildProgramUpdateProposal, type ProgramUpdateMode, type ProgramUpdateProposal } from "@/lib/program-update-reconciliation";
import { useDraftAutosave } from "@/components/program/editor/use-draft-autosave";

export type ProgramSlotRemovalRequest = {
  programId: string;
  dayLineageId: string;
  slotLineageId: string;
  exerciseId: string;
};

export function useProgramEditorController({
  ownerId,
  library,
  initialDayId,
  initialRemovalRequest,
}: {
  ownerId: string;
  library: ExerciseDiscoveryItem[];
  initialDayId: string | null;
  initialRemovalRequest: ProgramSlotRemovalRequest | null;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("edit");
  const [activeDayId, setActiveDayId] = useState<string | null>(initialDayId);
  const [reviewing, setReviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [coachPrompt, setCoachPrompt] = useState("");
  const [coachMode, setCoachMode] = useState<ProgramUpdateMode>("update");
  const [coachBuilding, setCoachBuilding] = useState(false);
  const [coachMessage, setCoachMessage] = useState<string | null>(null);
  const [pairingDayId, setPairingDayId] = useState<string | null>(null);
  const [pairingSlotIds, setPairingSlotIds] = useState<string[]>([]);
  const [expandedSlotId, setExpandedSlotId] = useState<string | null>(
    initialRemovalRequest?.slotLineageId ?? null,
  );
  const [pendingFutureRemovalRequest, setPendingFutureRemovalRequest] =
    useState<ProgramSlotRemovalRequest | null>(initialRemovalRequest);
  const [coachProposal, setCoachProposal] = useState<{
    proposal: ProgramUpdateProposal;
    warnings: string[];
    confidence: number;
  } | null>(null);
  const [acceptedCoachChanges, setAcceptedCoachChanges] = useState<Set<string>>(new Set());
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmRestore, setConfirmRestore] =
    useState<ProgramHistoryEntry | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [comparison, setComparison] = useState<{
    versionNo: number;
    review: ProgramReview;
  } | null>(null);
  const [inspection, setInspection] = useState<{
    entry: ProgramHistoryEntry;
    document: StoredProgramDocument;
  } | null>(null);
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [conflictCopyMessage, setConflictCopyMessage] = useState<string | null>(
    null,
  );
  const dayHeadingRefs = useRef(new Map<string, HTMLHeadingElement>());
  const slotHeadingRefs = useRef(new Map<string, HTMLButtonElement>());
  const inspectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const restoreMutationRef = useRef(new Map<string, string>());
  const handleBaseVersionChange = useCallback(() => {
    setComparison(null);
    setInspection(null);
  }, []);
  const autosave = useDraftAutosave({
    ownerId,
    setActiveDayId,
    setExpandedSlotId,
    onBaseVersionChange: handleBaseVersionChange,
  });
  const {
    draft, document, revision, pendingMutationId, status, message, conflictDraft,
    review, documentRef, draftRef, revisionRef, pendingMutationRef, dirtyRef,
    setDocument, setRevision, setPendingMutationId, setStatus, setMessage,
    setConflictDraft, setReview, persistLocal, removeLocal, applyServerDraft,
    loadDraft, savePending,
  } = autosave;

  const exerciseById = useMemo(
    () => new Map(library.map((item) => [item.id, item])),
    [library],
  );

  const futureRemovalTarget = useMemo(() => {
    const request = pendingFutureRemovalRequest;
    if (!request || !document) return null;
    if (conflictDraft) {
      return {
        status: "blocked" as const,
        message:
          "Resolve the newer Program draft before staging this removal. Repbook has not changed either copy.",
      };
    }
    if (document.programId !== request.programId) {
      return {
        status: "blocked" as const,
        message:
          "This workout came from a different Program. Repbook will not guess which current exercise to remove.",
      };
    }
    const day = document.days.find(
      (candidate) => candidate.lineageId === request.dayLineageId,
    );
    if (!day) {
      return {
        status: "blocked" as const,
        message:
          "That workout day is no longer present in the current Program draft. Nothing was removed.",
      };
    }
    const slot = day.exercises.find(
      (candidate) => candidate.lineageId === request.slotLineageId,
    );
    if (!slot) {
      return {
        status: "blocked" as const,
        message:
          "That planned exercise is already absent from this Program day. Nothing was removed.",
      };
    }
    if (slot.exerciseId !== request.exerciseId) {
      return {
        status: "blocked" as const,
        message:
          "That Program slot now contains a different exercise. Repbook will not remove the replacement automatically.",
      };
    }
    if (day.exercises.length === 1) {
      return {
        status: "blocked" as const,
        message:
          "A Program day must keep at least one exercise. Add another exercise or remove the whole day in the Program editor.",
      };
    }
    return {
      status: "ready" as const,
      dayName: day.name,
      exerciseName:
        exerciseById.get(slot.exerciseId)?.name ?? "this exercise",
    };
  }, [
    conflictDraft,
    document,
    exerciseById,
    pendingFutureRemovalRequest,
  ]);

  function clearFutureRemovalRequest() {
    const day = documentRef.current?.days.find(
      (candidate) =>
        candidate.lineageId === pendingFutureRemovalRequest?.dayLineageId,
    );
    setPendingFutureRemovalRequest(null);
    router.replace(
      day ? `/program/edit?day=${encodeURIComponent(day.lineageId)}` : "/program/edit",
      { scroll: false },
    );
  }

  function stageFutureRemoval() {
    const request = pendingFutureRemovalRequest;
    if (!request || futureRemovalTarget?.status !== "ready") return;
    updateDocument((current) => {
      if (current.programId !== request.programId) return current;
      return {
        ...current,
        days: current.days.map((day) => {
          if (day.lineageId !== request.dayLineageId) return day;
          const slot = day.exercises.find(
            (candidate) => candidate.lineageId === request.slotLineageId,
          );
          if (
            !slot ||
            slot.exerciseId !== request.exerciseId ||
            day.exercises.length === 1
          ) {
            return day;
          }
          return removeProgramSlotFromDay(day, request.slotLineageId);
        }),
      };
    });
    setExpandedSlotId(null);
    setActiveTab("edit");
    setMessage(
      `${futureRemovalTarget.exerciseName} is staged for removal from future ${futureRemovalTarget.dayName} workouts. Review and publish the draft to apply it.`,
    );
    clearFutureRemovalRequest();
  }

  const updateDocument = useCallback(
    (updater: (current: ProgramDocumentV3) => ProgramDocumentV3) => {
      const current = documentRef.current;
      const currentDraft = draftRef.current;
      if (!current || !currentDraft) return;
      const next = updater(current);
      const mutationId = crypto.randomUUID();
      documentRef.current = next;
      setDocument(next);
      pendingMutationRef.current = mutationId;
      setPendingMutationId(mutationId);
      dirtyRef.current = true;
      setReview(null);
      setPublishedVersion(null);
      const recoveredLocally = persistLocal(
        next,
        mutationId,
        revisionRef.current,
      );
      const valid = programDocumentV3Schema.safeParse(next);
      if (valid.success) {
        setStatus(recoveredLocally ? "local" : "failed");
        setMessage(
          recoveredLocally
            ? null
            : "This browser could not keep a recovery copy. Retry the server save before leaving this page.",
        );
      } else {
        const issue =
          valid.error.issues[0]?.message ?? "Finish required fields to save.";
        setStatus("attention");
        setMessage(
          recoveredLocally
            ? `${issue} Your in-progress edit is saved on this device.`
            : `${issue} This browser could not keep the invalid in-progress edit, so do not leave this page.`,
        );
      }
    },
    [
      dirtyRef,
      documentRef,
      draftRef,
      pendingMutationRef,
      persistLocal,
      revisionRef,
      setDocument,
      setMessage,
      setPendingMutationId,
      setReview,
      setStatus,
    ],
  );

  async function buildCoachProposal() {
    const current = documentRef.current;
    if (!current || !coachPrompt.trim()) {
      setCoachMessage("Describe the Program you want first.");
      return;
    }
    setCoachBuilding(true);
    setCoachMessage(null);
    setCoachProposal(null);
    try {
      const result = await buildProgramRoutineDraft(
        coachPrompt,
        projectIntentProgramDocumentV2(current),
        activeDayId,
      );
      if (!result.ok) {
        setCoachMessage(result.reason);
        return;
      }
      const proposal = buildProgramUpdateProposal({
        current: projectIntentProgramDocumentV2(current),
        candidate: result.draft,
        library,
        sourceText: coachPrompt,
        mode: coachMode,
        candidateProgramName: result.programName,
      });
      setCoachProposal({
        proposal,
        warnings: [...result.warnings, ...proposal.warnings],
        confidence: result.confidence,
      });
      setAcceptedCoachChanges(new Set(proposal.changes.filter((change) => change.acceptedByDefault).map((change) => change.id)));
    } catch {
      setCoachMessage(
        "The Coach could not build that proposal. Try again with a shorter description.",
      );
    } finally {
      setCoachBuilding(false);
    }
  }

  function updateDay(
    dayIndex: number,
    updater: (day: ProgramDocumentDayV3) => ProgramDocumentDayV3,
  ) {
    updateDocument((current) =>
      updateProgramDocumentDay(current, dayIndex, updater),
    );
  }

  function addExercise(dayIndex: number, exerciseId: string) {
    const lineageId = crypto.randomUUID();
    updateDocument((current) =>
      addProgramExerciseToDay(current, dayIndex, exerciseId, lineageId),
    );
    setExpandedSlotId(lineageId);
  }

  function addDay(exerciseId: string) {
    const lineageId = crypto.randomUUID();
    const slotLineageId = crypto.randomUUID();
    updateDocument((current) =>
      appendProgramDocumentDay(
        current,
        exerciseId,
        lineageId,
        slotLineageId,
      ),
    );
    setActiveDayId(lineageId);
    router.push(`/program/edit?day=${lineageId}`, { scroll: false });
  }

  function moveSlotToDay(
    sourceDay: number,
    slotIndex: number,
    targetDay: number,
  ) {
    const movedLineageId =
      documentRef.current?.days[sourceDay]?.exercises[slotIndex]?.lineageId;
    updateDocument((current) =>
      moveProgramSlotToDayDocument(
        current,
        sourceDay,
        slotIndex,
        targetDay,
      ),
    );
    requestAnimationFrame(() => {
      if (movedLineageId) {
        slotHeadingRefs.current.get(movedLineageId)?.focus();
      }
    });
  }

  async function requestReview() {
    if (!draft || !document || dirtyRef.current || pendingMutationRef.current)
      return;
    setReviewing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/program/draft/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId: draft.id,
          expectedRevision: revisionRef.current,
        }),
      });
      const nextReview = parseProgramReviewResponse(
        await responseJson(response),
      );
      setReview(nextReview);
      setActiveTab("review");
    } catch (error) {
      setStatus("failed");
      setMessage(
        error instanceof Error ? error.message : "The Program review failed.",
      );
    } finally {
      setReviewing(false);
    }
  }

  async function publish() {
    if (
      !draft ||
      !review ||
      review.status !== "publishable" ||
      review.reviewedRevision !== revisionRef.current
    )
      return;
    setPublishing(true);
    try {
      const response = await fetch("/api/program/draft/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId: draft.id,
          expectedRevision: revisionRef.current,
          reviewHash: review.hash,
        }),
      });
      const result = (await responseJson(response)) as Record<string, unknown>;
      const versionNo = Number(
        result.versionNo ??
          (result.version && typeof result.version === "object"
            ? (result.version as { versionNo?: unknown }).versionNo
            : NaN),
      );
      setPublishedVersion(Number.isInteger(versionNo) ? versionNo : 0);
      removeLocal(draft.id);
      dirtyRef.current = false;
      setStatus("saved");
      setReview(null);
      setComparison(null);
      setInspection(null);
      void loadDraft(false);
      router.refresh();
    } catch (error) {
      setStatus("failed");
      setMessage(
        error instanceof Error
          ? error.message
          : "The future Program was not published.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function discard() {
    if (!draft) return;
    setDiscarding(true);
    try {
      const response = await fetch("/api/program/draft", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId: draft.id,
          expectedRevision: revisionRef.current,
        }),
      });
      await responseJson(response);
      removeLocal(draft.id);
      dirtyRef.current = false;
      router.push("/program");
      router.refresh();
    } catch (error) {
      setStatus("failed");
      setMessage(
        error instanceof Error
          ? error.message
          : "The draft could not be discarded.",
      );
      setConfirmDiscard(false);
    } finally {
      setDiscarding(false);
    }
  }

  async function restoreVersion(entry: ProgramHistoryEntry) {
    if (!draft) return;
    setRestoringId(entry.id);
    const key = `${draft.id}:${revisionRef.current}:${entry.id}`;
    const mutationId =
      restoreMutationRef.current.get(key) ?? crypto.randomUUID();
    restoreMutationRef.current.set(key, mutationId);
    try {
      const response = await fetch("/api/program/draft/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          versionId: entry.id,
          currentDraftId: draft.id,
          expectedRevision: revisionRef.current,
          mutationId,
        }),
      });
      await responseJson(response);
      restoreMutationRef.current.delete(key);
      if (draft) removeLocal(draft.id);
      setConfirmRestore(null);
      setComparison(null);
      setInspection(null);
      await loadDraft(false);
      setActiveTab("edit");
    } catch (error) {
      setStatus("failed");
      setMessage(
        error instanceof Error
          ? error.message
          : "That version could not be copied into a draft.",
      );
      setConfirmRestore(null);
    } finally {
      setRestoringId(null);
    }
  }

  async function compareVersion(entry: ProgramHistoryEntry) {
    try {
      const response = await fetch(
        `/api/program/versions/${entry.id}/compare`,
        { cache: "no-store" },
      );
      const result = (await responseJson(response)) as { comparison?: unknown };
      setComparison({
        versionNo: entry.versionNo,
        review: parseProgramReviewResponse(result.comparison),
      });
    } catch (error) {
      setStatus("failed");
      setMessage(
        error instanceof Error
          ? error.message
          : "That Program version could not be compared.",
      );
    }
  }

  async function inspectVersion(entry: ProgramHistoryEntry) {
    setInspectingId(entry.id);
    try {
      const response = await fetch(`/api/program/versions/${entry.id}/export`, {
        cache: "no-store",
      });
      const result = (await responseJson(response)) as { document?: unknown };
      const parsed = storedProgramDocumentSchema.safeParse(result.document);
      if (!parsed.success || parsed.data.baseVersionId !== entry.id) {
        throw new Error("That Program version could not be inspected safely.");
      }
      setInspection({ entry, document: parsed.data });
      requestAnimationFrame(() => inspectionHeadingRef.current?.focus());
    } catch (error) {
      setStatus("failed");
      setMessage(
        error instanceof Error
          ? error.message
          : "That Program version could not be inspected.",
      );
    } finally {
      setInspectingId(null);
    }
  }

  function exportDraft() {
    if (!document) return;
    const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `${programEditorSafeFilePart(document.name)}-draft-r${revisionRef.current}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return {
    router, library,
    draft, document, revision, pendingMutationId, status, message, conflictDraft,
    review, activeTab, activeDayId, reviewing, publishing, discarding, restoringId,
    coachPrompt, coachMode, coachBuilding, coachMessage, pairingDayId, pairingSlotIds,
    expandedSlotId, coachProposal, acceptedCoachChanges, confirmDiscard, confirmRestore,
    pendingFutureRemovalRequest, futureRemovalTarget,
    publishedVersion, comparison, inspection, inspectingId, conflictCopyMessage,
    dayHeadingRefs, slotHeadingRefs, inspectionHeadingRef, documentRef, draftRef,
    revisionRef, pendingMutationRef, dirtyRef, exerciseById,
    setRevision, setPendingMutationId, setStatus, setMessage, setConflictDraft, setReview,
    setActiveTab, setActiveDayId, setCoachPrompt, setCoachMode, setCoachMessage, setPairingDayId,
    setPairingSlotIds, setExpandedSlotId, setCoachProposal, setAcceptedCoachChanges,
    setConfirmDiscard, setConfirmRestore, setPublishedVersion, setComparison,
    setInspection, setConflictCopyMessage, persistLocal, removeLocal, applyServerDraft,
    loadDraft, savePending, updateDocument, buildCoachProposal, updateDay, addExercise,
    addDay, moveSlotToDay, requestReview, publish, discard, restoreVersion,
    clearFutureRemovalRequest, stageFutureRemoval,
    compareVersion, inspectVersion, exportDraft,
  };
}

export type ProgramEditorController = ReturnType<typeof useProgramEditorController>;
