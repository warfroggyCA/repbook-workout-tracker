"use client";

import Link from "next/link";
import { ArrowLeft, Check, CircleAlert, Copy, Download, History, RefreshCw, Save, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import { programDocumentV3Schema } from "@/lib/program-document";
import { ConfirmDialog, Status } from "@/components/program/editor/editor-ui";
import { AiRebuildDialog } from "@/components/program/editor/ai-rebuild-dialog";
import { DayEditor } from "@/components/program/editor/day-editor";
import { ReviewDialog } from "@/components/program/editor/review-dialog";
import { HistoryPanel } from "@/components/program/editor/history-panel";
import { useProgramEditorController } from "@/components/program/editor/use-program-editor-controller";
import { ProgramEditorDocumentContext, ProgramEditorStatusContext } from "@/components/program/editor/editor-store";
export function ProgramEditor({
  ownerId,
  library,
  initialDayId,
}: {
  ownerId: string;
  library: ExerciseDiscoveryItem[];
  initialDayId: string | null;
}) {
  const editor = useProgramEditorController({ ownerId, library, initialDayId });
  const {
    draft, document, revision, pendingMutationId, status, message, conflictDraft,
    review, activeTab, discarding, restoringId, confirmDiscard, confirmRestore,
    publishedVersion, conflictCopyMessage, revisionRef, pendingMutationRef,
    dirtyRef, setRevision, setPendingMutationId, setStatus, setMessage,
    setConflictDraft, setActiveTab, setConfirmDiscard, setConfirmRestore,
    setConflictCopyMessage, persistLocal, removeLocal, applyServerDraft,
    loadDraft, savePending, discard, restoreVersion, exportDraft,
  } = editor;
  if (!document || !draft) {
    return (
      <main className="p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-3xl space-y-4">
          <Button
            variant="ghost"
            render={<Link href="/program" />}
            nativeButton={false}
          >
            <ArrowLeft /> Back to Program
          </Button>
          <Card>
            <CardHeader>
              <CardTitle>Program editor</CardTitle>
              <CardDescription>
                {message ?? "Loading your durable draft…"}
              </CardDescription>
            </CardHeader>
            {status === "failed" && (
              <CardContent>
                <Button
                  type="button"
                  className="min-h-11"
                  onClick={() => {
                    setStatus("loading");
                    setMessage("Reconnecting to your saved Program draft…");
                    void loadDraft(true);
                  }}
                >
                  <RefreshCw /> Retry loading draft
                </Button>
              </CardContent>
            )}
          </Card>
        </div>
      </main>
    );
  }

  const documentValidation = programDocumentV3Schema.safeParse(document);
  const canReview =
    documentValidation.success && !pendingMutationId && status === "saved";
  const currentReview = review?.reviewedRevision === revision ? review : null;

  return (
    <ProgramEditorDocumentContext.Provider value={{ draft, document, revision, pendingMutationId, dirty: pendingMutationId != null, review }}>
    <ProgramEditorStatusContext.Provider value={{ status, message, conflictDraft }}>
    <main className="p-3 pb-24 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-6xl [&_button]:min-h-11 [&_input]:min-h-11 [&_select]:min-h-11">
        <header className="mb-5 flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
          <div>
            <Button
              variant="ghost"
              className="-ml-2 mb-2"
              render={<Link href="/program" />}
              nativeButton={false}
            >
              <ArrowLeft /> Back to Program
            </Button>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Durable Program draft
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
              Edit {document.name}
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Changes save automatically. Activation creates a new version;
              active and completed workouts never change.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(15rem,1fr)_auto_auto_auto]">
            <Status status={status} message={message} />
            {status === "failed" && pendingMutationId && !conflictDraft && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void savePending()}
              >
                <RefreshCw /> Retry save
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={exportDraft}
            >
              <Download /> Export draft JSON
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              onClick={() => setConfirmDiscard(true)}
            >
              <Trash2 /> Discard draft
            </Button>
          </div>
        </header>

        {conflictDraft && (
          <Alert className="mb-5 border-destructive/40">
            <CircleAlert />
            <AlertTitle>Another tab has a newer server draft</AlertTitle>
            <AlertDescription>
              <p>
                Your local copy has not been overwritten. Copy it if useful,
                then explicitly choose which version to continue.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setConflictCopyMessage(null);
                    void (async () => {
                      try {
                        if (!navigator.clipboard?.writeText) {
                          throw new Error("Clipboard access is unavailable.");
                        }
                        await navigator.clipboard.writeText(
                          JSON.stringify(document, null, 2),
                        );
                        setConflictCopyMessage("Local draft JSON copied.");
                      } catch {
                        setConflictCopyMessage(
                          "This browser could not copy the draft. Use Export draft JSON before choosing another copy.",
                        );
                      }
                    })();
                  }}
                >
                  <Copy /> Copy local JSON
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (!removeLocal(draft.id)) {
                      setStatus("failed");
                      setMessage(
                        "This browser could not clear its local copy. Copy the JSON before retrying so it cannot reappear after a reload.",
                      );
                      return;
                    }
                    setConflictCopyMessage(null);
                    setConflictDraft(null);
                    applyServerDraft(conflictDraft, false);
                  }}
                >
                  <RefreshCw /> Load server draft
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    const mutationId = crypto.randomUUID();
                    const reconciledDocument = {
                      ...document,
                      programId: conflictDraft.document.programId,
                      baseVersionId: conflictDraft.document.baseVersionId,
                    };
                    revisionRef.current = conflictDraft.revision;
                    setRevision(conflictDraft.revision);
                    setConflictCopyMessage(null);
                    setConflictDraft(null);
                    pendingMutationRef.current = mutationId;
                    setPendingMutationId(mutationId);
                    dirtyRef.current = true;
                    const recoveredLocally = persistLocal(
                      reconciledDocument,
                      mutationId,
                      conflictDraft.revision,
                    );
                    applyServerDraft(
                      {
                        ...conflictDraft,
                        document: reconciledDocument,
                        reviewHash: null,
                        reviewSummary: null,
                        reviewedRevision: null,
                        reviewState: { status: "none" },
                      },
                      false,
                    );
                    pendingMutationRef.current = mutationId;
                    setPendingMutationId(mutationId);
                    dirtyRef.current = true;
                    setStatus(recoveredLocally ? "local" : "failed");
                    setMessage(
                      recoveredLocally
                        ? "Local copy selected. Saving it as the next revision…"
                        : "Local copy selected, but this browser could not keep a recovery copy. Retry the server save before leaving.",
                    );
                  }}
                >
                  <Save /> Keep local copy
                </Button>
              </div>
              {conflictCopyMessage && (
                <p className="mt-2" role="status" aria-live="polite">
                  {conflictCopyMessage}
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}

        {draft.reviewState.status === "expired" && !currentReview && (
          <Alert className="mb-5 border-amber-500/50">
            <CircleAlert />
            <AlertTitle>Fresh review required</AlertTitle>
            <AlertDescription>
              {draft.reviewState.reason} The durable draft and Program version
              history are unchanged; compare the draft with the current Program
              again before activation.
            </AlertDescription>
          </Alert>
        )}

        {publishedVersion != null && (
          <Alert className="mb-5 border-primary/40">
            <Check />
            <AlertTitle>New Program version activated</AlertTitle>
            <AlertDescription>
              Version {publishedVersion || "created"} is now current. Earlier
              versions and workouts remain unchanged.{" "}
              <Link className="font-medium underline" href="/program">
                View active Program
              </Link>
              .
            </AlertDescription>
          </Alert>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-5 grid h-auto w-full grid-cols-3 gap-1 p-1 sm:w-fit">
            <TabsTrigger value="edit" className="min-h-11 px-3">
              Edit
            </TabsTrigger>
            <TabsTrigger value="review" className="min-h-11 px-3">
              Review
            </TabsTrigger>
            <TabsTrigger value="history" className="min-h-11 px-3">
              <History /> Versions
            </TabsTrigger>
          </TabsList>

          <TabsContent value="edit" className="space-y-5">
            <AiRebuildDialog editor={editor} />
            <DayEditor editor={editor} canReview={canReview} />
          </TabsContent>

          <TabsContent value="review" className="space-y-4">
            <ReviewDialog editor={editor} currentReview={currentReview} canReview={canReview} />
          </TabsContent>

          <TabsContent value="history" className="space-y-4">
            <HistoryPanel editor={editor} />
          </TabsContent>
        </Tabs>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this Program draft?"
        description="The active Program and all earlier versions stay unchanged. Only this open draft and its matching local recovery copy are removed."
        confirmLabel="Discard draft"
        busy={discarding}
        onConfirm={() => void discard()}
      />
      <ConfirmDialog
        open={confirmRestore != null}
        onOpenChange={(open) => !open && setConfirmRestore(null)}
        title={`Restore v${confirmRestore?.versionNo ?? ""} as a new draft?`}
        description="Your active version remains unchanged. This replaces the open draft with a copy of the selected historical version; the discarded draft remains available through recovery. The restored copy must pass a fresh review before activation."
        confirmLabel="Create restore draft"
        busy={restoringId != null}
        onConfirm={() => confirmRestore && void restoreVersion(confirmRestore)}
      />
    </main>
    </ProgramEditorStatusContext.Provider>
    </ProgramEditorDocumentContext.Provider>
  );
}
