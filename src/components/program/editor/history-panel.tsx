"use client";

import { Download, History, LoaderCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VersionInspection } from "@/components/program/editor/history-inspection";
import type { ProgramEditorController } from "@/components/program/editor/use-program-editor-controller";
import { formatProgramReviewValue } from "@/lib/program-editor-client";

export function HistoryPanel({ editor }: { editor: ProgramEditorController }) {
  const { inspection, exerciseById, inspectionHeadingRef, setInspection, comparison, draft, inspectingId, inspectVersion, compareVersion, restoringId, setConfirmRestore } = editor;
  if (!draft) return null;
  return (
    <>
            {inspection && (
              <VersionInspection
                entry={inspection.entry}
                document={inspection.document}
                exerciseById={exerciseById}
                headingRef={inspectionHeadingRef}
                onClose={() => setInspection(null)}
              />
            )}
            {comparison && (
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h2 className="text-lg font-semibold">
                      v{comparison.versionNo} compared with current
                    </h2>
                  </CardTitle>
                  <CardDescription>
                    {comparison.review.changes.length} meaningful difference
                    {comparison.review.changes.length === 1 ? "" : "s"}.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ol className="space-y-2">
                    {comparison.review.changes.map((change, index) => (
                      <li
                        key={`${change.path}-${index}`}
                        className="rounded-lg border p-3 text-sm"
                      >
                        <Badge variant="outline">{change.kind}</Badge>
                        <p className="mt-2 font-medium">{change.label}</p>
                        <p className="mt-1 text-muted-foreground">
                          {formatProgramReviewValue(change.before)} →{" "}
                          {formatProgramReviewValue(change.after)}
                        </p>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2 className="text-lg font-semibold">Program versions</h2>
                </CardTitle>
                <CardDescription>
                  Inspect or export any immutable version. Restore copies a
                  historical version into a new reviewed draft.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {draft.history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No activated versions were returned.
                  </p>
                ) : (
                  <ol className="space-y-3">
                    {[...draft.history]
                      .sort((a, b) => b.versionNo - a.versionNo)
                      .map((entry) => (
                        <li
                          key={entry.id}
                          className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="font-semibold">
                                v{entry.versionNo} · {entry.name}
                              </h3>
                              {entry.isCurrent && <Badge>Current</Badge>}
                              {entry.source && (
                                <Badge variant="outline">
                                  {entry.source.replaceAll("_", " ")}
                                </Badge>
                              )}
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {entry.summary ??
                                "No activation summary recorded."}
                            </p>
                            {entry.activatedAt && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Activated{" "}
                                {new Date(entry.activatedAt).toLocaleString()}
                              </p>
                            )}
                            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                              {entry.parentVersionId && (
                                <span>
                                  Follows v
                                  {draft.history.find(
                                    (version) =>
                                      version.id === entry.parentVersionId,
                                  )?.versionNo ?? "?"}
                                </span>
                              )}
                              {entry.restoredFromVersionId && (
                                <span>
                                  Restored from v
                                  {draft.history.find(
                                    (version) =>
                                      version.id ===
                                      entry.restoredFromVersionId,
                                  )?.versionNo ?? "?"}
                                </span>
                              )}
                              {entry.sourceImportEventId && (
                                <span>Linked to reviewed import evidence</span>
                              )}
                              {entry.reviewHash && (
                                <span>Semantic review verified</span>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11"
                              disabled={inspectingId != null}
                              onClick={() => void inspectVersion(entry)}
                            >
                              {inspectingId === entry.id ? (
                                <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                              ) : (
                                <History />
                              )}{" "}
                              Inspect v{entry.versionNo}
                            </Button>
                            {!entry.isCurrent && (
                              <Button
                                type="button"
                                variant="outline"
                                className="min-h-11"
                                onClick={() => void compareVersion(entry)}
                              >
                                Compare with current
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              className="min-h-11"
                              render={
                                <a
                                  href={`/api/program/versions/${entry.id}/export`}
                                />
                              }
                              nativeButton={false}
                            >
                              <Download /> Export v{entry.versionNo}
                            </Button>
                            {!entry.isCurrent && (
                              <Button
                                type="button"
                                className="min-h-11"
                                disabled={restoringId != null}
                                onClick={() => setConfirmRestore(entry)}
                              >
                                <RefreshCw /> Restore as new draft
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                  </ol>
                )}
              </CardContent>
            </Card>
    </>
  );
}
