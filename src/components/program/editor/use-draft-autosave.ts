"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  PROGRAM_DRAFT_LOCAL_SCHEMA, PROGRAM_DRAFT_LOCAL_PREFIX,
  isLocallyRecoverableProgramDocument, localProgramDraftKey, parseLocalProgramDraft,
  parseProgramDraftResponse as parseDraftResponse, programEditorResponseJson as responseJson,
  type LocalProgramDraft, type ProgramReview, type ServerDraft,
} from "@/lib/program-editor-client";
import { programDocumentV3Schema, type ProgramDocumentV3 } from "@/lib/program-document";
import type { ProgramEditorSaveStatus as SaveStatus } from "@/components/program/editor/editor-store";

type NullableSetter = Dispatch<SetStateAction<string | null>>;

export function useDraftAutosave({ ownerId, setActiveDayId, setExpandedSlotId, onBaseVersionChange }: {
  ownerId: string;
  setActiveDayId: NullableSetter;
  setExpandedSlotId: NullableSetter;
  onBaseVersionChange: () => void;
}) {
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [document, setDocument] = useState<ProgramDocumentV3 | null>(null);
  const [revision, setRevision] = useState(0);
  const [pendingMutationId, setPendingMutationId] = useState<string | null>(
    null,
  );
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [conflictDraft, setConflictDraft] = useState<ServerDraft | null>(null);
  const [review, setReview] = useState<ProgramReview | null>(null);
  const documentRef = useRef<ProgramDocumentV3 | null>(null);
  const draftRef = useRef<ServerDraft | null>(null);
  const revisionRef = useRef(0);
  const pendingMutationRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const persistLocal = useCallback(
    (
      nextDocument: ProgramDocumentV3,
      mutationId: string,
      serverRevision: number,
    ) => {
      const currentDraft = draftRef.current;
      if (!currentDraft) return false;
      if (!isLocallyRecoverableProgramDocument(nextDocument)) return false;
      const record: LocalProgramDraft = {
        schemaVersion: PROGRAM_DRAFT_LOCAL_SCHEMA,
        ownerId,
        draftId: currentDraft.id,
        serverRevision,
        mutationId,
        document: nextDocument,
        savedAt: new Date().toISOString(),
      };
      try {
        localStorage.setItem(
          localProgramDraftKey(ownerId, currentDraft.id),
          JSON.stringify(record),
        );
        return true;
      } catch {
        return false;
      }
    },
    [ownerId],
  );

  const removeLocal = useCallback(
    (draftId: string) => {
      try {
        localStorage.removeItem(localProgramDraftKey(ownerId, draftId));
        return true;
      } catch {
        return false;
      }
    },
    [ownerId],
  );

  const applyServerDraft = useCallback(
    (serverDraft: ServerDraft, allowLocal: boolean) => {
      const previousBaseVersionId = draftRef.current?.document.baseVersionId;
      if (
        previousBaseVersionId &&
        previousBaseVersionId !== serverDraft.document.baseVersionId
      ) {
        onBaseVersionChange();
      }
      draftRef.current = serverDraft;
      setDraft(serverDraft);
      revisionRef.current = serverDraft.revision;
      setRevision(serverDraft.revision);
      setReview(serverDraft.reviewSummary);
      let nextDocument = serverDraft.document;
      let nextMutation: string | null = null;
      let localReadFailed = false;
      if (allowLocal) {
        let rawLocal: string | null = null;
        try {
          rawLocal = localStorage.getItem(
            localProgramDraftKey(ownerId, serverDraft.id),
          );
        } catch {
          localReadFailed = true;
        }
        const local = parseLocalProgramDraft(rawLocal);
        if (
          local &&
          local.ownerId === ownerId &&
          local.draftId === serverDraft.id
        ) {
          const differs =
            JSON.stringify(local.document) !==
            JSON.stringify(serverDraft.document);
          if (differs && local.serverRevision === serverDraft.revision) {
            nextDocument = local.document;
            nextMutation = local.mutationId;
            dirtyRef.current = true;
            setStatus("local");
          } else if (differs) {
            nextDocument = local.document;
            nextMutation = local.mutationId;
            dirtyRef.current = true;
            setConflictDraft(serverDraft);
            setStatus("conflict");
          } else {
            dirtyRef.current = false;
            setStatus("saved");
          }
        } else {
          dirtyRef.current = false;
          setStatus("saved");
        }
      } else {
        dirtyRef.current = false;
        setStatus("saved");
      }
      documentRef.current = nextDocument;
      setDocument(nextDocument);
      setActiveDayId((current) =>
        nextDocument.days.some((day) => day.lineageId === current)
          ? current
          : nextDocument.days[0]?.lineageId ?? null,
      );
      setExpandedSlotId((current) =>
        nextDocument.days.some((day) =>
          day.exercises.some((slot) => slot.lineageId === current),
        )
          ? current
          : (nextDocument.days[0]?.exercises[0]?.lineageId ?? null),
      );
      pendingMutationRef.current = nextMutation;
      setPendingMutationId(nextMutation);
      setMessage(
        localReadFailed
          ? "The server draft loaded, but this browser does not allow a local recovery copy."
          : null,
      );
    },
    [onBaseVersionChange, ownerId, setActiveDayId, setExpandedSlotId],
  );

  const fetchServerDraft = useCallback(async () => {
    let response = await fetch("/api/program/draft", { cache: "no-store" });
    if (response.status === 404) {
      response = await fetch("/api/program/draft", { method: "POST" });
    }
    return parseDraftResponse(await responseJson(response));
  }, []);

  const loadDraft = useCallback(
    async (allowLocal = true) => {
      try {
        const serverDraft = await fetchServerDraft();
        applyServerDraft(serverDraft, allowLocal);
        return serverDraft;
      } catch (error) {
        if (allowLocal) {
          try {
            const prefix = `${PROGRAM_DRAFT_LOCAL_PREFIX}:${ownerId}:`;
            const recovered = Array.from(
              { length: localStorage.length },
              (_, index) => localStorage.key(index),
            )
              .filter((key): key is string => Boolean(key?.startsWith(prefix)))
              .map((key) => parseLocalProgramDraft(localStorage.getItem(key)))
              .filter((value): value is LocalProgramDraft => value != null)
              .sort((left, right) =>
                right.savedAt.localeCompare(left.savedAt),
              )[0];
            if (recovered) {
              applyServerDraft(
                {
                  id: recovered.draftId,
                  revision: recovered.serverRevision,
                  document: recovered.document,
                  reviewedRevision: null,
                  reviewHash: null,
                  reviewSummary: null,
                  reviewState: { status: "none" },
                  history: [],
                },
                false,
              );
              pendingMutationRef.current = recovered.mutationId;
              setPendingMutationId(recovered.mutationId);
              dirtyRef.current = true;
              setStatus(navigator.onLine ? "local" : "queued");
              setMessage(
                navigator.onLine
                  ? "Recovered this browser's unsent draft. Reconnecting it to the server…"
                  : "Recovered this browser's unsent draft while offline. It will retry when connected.",
              );
              return null;
            }
          } catch {
            // The regular error state below remains available when browser
            // storage cannot be read.
          }
        }
        setStatus("failed");
        setMessage(
          error instanceof Error
            ? error.message
            : "The Program draft could not be loaded.",
        );
        return null;
      }
    },
    [applyServerDraft, fetchServerDraft, ownerId],
  );

  const savePending = useCallback(async () => {
    const currentDraft = draftRef.current;
    const currentDocument = documentRef.current;
    const mutationId = pendingMutationRef.current;
    if (
      !currentDraft ||
      !currentDocument ||
      !mutationId ||
      savingRef.current ||
      conflictDraft
    )
      return;
    const valid = programDocumentV3Schema.safeParse(currentDocument);
    if (!valid.success) {
      const recoveredLocally = persistLocal(
        currentDocument,
        mutationId,
        revisionRef.current,
      );
      const issue =
        valid.error.issues[0]?.message ?? "Finish the required Program fields.";
      setStatus("attention");
      setMessage(
        recoveredLocally
          ? `${issue} Your in-progress edit is saved on this device.`
          : `${issue} This browser could not keep a recovery copy, so do not leave this page.`,
      );
      return;
    }
    const expectedRevision = revisionRef.current;
    const run = async () => {
      if (savingRef.current) return;
      let saveSucceeded = false;
      savingRef.current = true;
      setStatus("saving");
      setMessage(null);
      try {
        const response = await fetch("/api/program/draft", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            draftId: currentDraft.id,
            expectedRevision,
            mutationId,
            document: valid.data,
          }),
        });
        const result = (await responseJson(response)) as Record<
          string,
          unknown
        >;
        if (result.status === "conflict") {
          const parsedServer =
            result.serverDraft && typeof result.serverDraft === "object"
              ? parseDraftResponse({ status: "ok", draft: result.serverDraft })
              : await fetchServerDraft();
          const server =
            parsedServer.history.length > 0
              ? parsedServer
              : { ...parsedServer, history: currentDraft.history };
          setConflictDraft(server);
          setStatus("conflict");
          setMessage(
            "Another tab saved a newer draft. Choose which copy to continue from.",
          );
          return;
        }
        if (result.status === "invalid" && Array.isArray(result.errors)) {
          throw new Error(result.errors.map(String).join(" "));
        }
        if (result.status !== "saved" || !Number.isInteger(result.revision)) {
          throw new Error("The server did not confirm the Program save.");
        }
        const savedRevision = result.revision as number;
        saveSucceeded = true;
        revisionRef.current = savedRevision;
        setRevision(savedRevision);
        const stillCurrent = pendingMutationRef.current === mutationId;
        if (stillCurrent) {
          pendingMutationRef.current = null;
          setPendingMutationId(null);
          dirtyRef.current = false;
        }
        const recoveredLocally = persistLocal(
          documentRef.current ?? valid.data,
          pendingMutationRef.current ?? mutationId,
          savedRevision,
        );
        if (stillCurrent) {
          setStatus("saved");
          setMessage(
            recoveredLocally
              ? null
              : "The server saved this revision, but this browser could not keep a second recovery copy.",
          );
        } else if (!recoveredLocally) {
          setMessage(
            "The server saved the earlier revision, but this browser could not keep a recovery copy of the newer edit.",
          );
        }
        channelRef.current?.postMessage({
          type: "saved",
          draftId: currentDraft.id,
          revision: savedRevision,
          mutationId,
        });
      } catch (error) {
        setStatus(navigator.onLine ? "failed" : "queued");
        setMessage(
          navigator.onLine
            ? error instanceof Error
              ? error.message
              : "The Program save failed. Retry when ready."
            : "You are offline. This draft is saved on this device and will retry when connected.",
        );
      } finally {
        savingRef.current = false;
        if (
          saveSucceeded &&
          pendingMutationRef.current &&
          pendingMutationRef.current !== mutationId
        ) {
          setSaveAttempt((attempt) => attempt + 1);
        }
      }
    };
    if (navigator.locks) {
      await navigator.locks.request(`program-draft:${currentDraft.id}`, run);
    } else {
      await run();
    }
  }, [conflictDraft, fetchServerDraft, persistLocal]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDraft(true), 0);
    return () => window.clearTimeout(timer);
  }, [loadDraft]);

  useEffect(() => {
    if (!draft || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(`program-draft:${draft.id}`);
    channelRef.current = channel;
    channel.onmessage = (
      event: MessageEvent<{ type?: string; revision?: number }>,
    ) => {
      if (
        event.data?.type !== "saved" ||
        !Number.isInteger(event.data.revision) ||
        (event.data.revision ?? 0) <= revisionRef.current
      )
        return;
      const hadLocalChanges = dirtyRef.current;
      void fetchServerDraft()
        .then((server) => {
          if (hadLocalChanges || dirtyRef.current) {
            setConflictDraft(server);
            setStatus("conflict");
            setMessage(
              "Another tab saved a newer draft while this tab had local changes.",
            );
          } else {
            applyServerDraft(server, false);
          }
        })
        .catch(() => {
          setStatus("failed");
          setMessage(
            "Another tab saved this draft, but its latest copy could not be loaded. Retry before editing.",
          );
        });
    };
    return () => {
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [applyServerDraft, draft, fetchServerDraft]);

  useEffect(() => {
    if (!draft) return;
    const onStorage = (event: StorageEvent) => {
      if (
        event.key !== localProgramDraftKey(ownerId, draft.id) ||
        !event.newValue
      )
        return;
      const local = parseLocalProgramDraft(event.newValue);
      if (!local || local.mutationId === pendingMutationRef.current) return;
      if (local.serverRevision <= revisionRef.current) return;
      const hadLocalChanges = dirtyRef.current;
      void fetchServerDraft()
        .then((server) => {
          if (hadLocalChanges || dirtyRef.current) {
            setConflictDraft(server);
            setStatus("conflict");
            setMessage(
              "Another tab changed this draft. Review both copies before continuing.",
            );
          } else {
            applyServerDraft(server, false);
          }
        })
        .catch(() => {
          setStatus("failed");
          setMessage(
            "Another tab changed this draft, but the server copy could not be loaded. Retry before editing.",
          );
        });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [applyServerDraft, draft, fetchServerDraft, ownerId]);

  useEffect(() => {
    if (!pendingMutationId || conflictDraft) return;
    const timer = window.setTimeout(() => void savePending(), 800);
    return () => window.clearTimeout(timer);
  }, [conflictDraft, pendingMutationId, saveAttempt, savePending]);

  useEffect(() => {
    const retry = () => {
      if (!draftRef.current) {
        setStatus("loading");
        setMessage("Reconnecting to your saved Program draft…");
        void loadDraft(true);
      } else if (dirtyRef.current && !conflictDraft) {
        void savePending();
      }
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
    };
  }, [conflictDraft, loadDraft, savePending]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && status !== "conflict") return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  return {
    draft, document, revision, pendingMutationId, status, message, conflictDraft, review,
    documentRef, draftRef, revisionRef, pendingMutationRef, dirtyRef,
    setDocument, setRevision, setPendingMutationId, setStatus, setMessage, setConflictDraft, setReview,
    persistLocal, removeLocal, applyServerDraft, loadDraft, savePending,
  };
}
