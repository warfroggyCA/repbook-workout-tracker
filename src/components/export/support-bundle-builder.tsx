"use client";

import { useMemo, useState } from "react";
import { Download, FileCheck2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  buildSupportBundle,
  collectBrowserSupportContext,
  serializeSupportBundle,
  SUPPORT_BUNDLE_REDACTION_VERSION,
  SUPPORT_BUNDLE_SCHEMA_VERSION,
  SUPPORT_PROBLEMS,
  supportBundleFilename,
  type SupportContextCollection,
  type SupportProblemType,
} from "@/lib/support-bundle";

type PreparedSeed = Readonly<{
  correlationId: string;
  generatedAt: string;
  diagnosticContext: SupportContextCollection;
}>;

function firstObservedState(problemType: SupportProblemType) {
  const first = Object.keys(SUPPORT_PROBLEMS[problemType].observedStates)[0];
  if (!first) throw new Error("The support problem has no outcome choices.");
  return first;
}

export function SupportBundleBuilder({ appVersion }: { appVersion: string }) {
  const [problemType, setProblemType] =
    useState<SupportProblemType>("workout_start");
  const [observedState, setObservedState] = useState(
    firstObservedState("workout_start"),
  );
  const [includeDiagnosticContext, setIncludeDiagnosticContext] =
    useState(true);
  const [includeOwnerNote, setIncludeOwnerNote] = useState(false);
  const [ownerNote, setOwnerNote] = useState("");
  const [prepared, setPrepared] = useState<PreparedSeed | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  const rendered = useMemo(() => {
    if (!prepared) return { bundle: null, error: null, exactPreview: null };
    try {
      const bundle = buildSupportBundle({
        appVersion,
        correlationId: prepared.correlationId,
        generatedAt: prepared.generatedAt,
        problemType,
        observedState,
        includeDiagnosticContext,
        diagnosticContext: prepared.diagnosticContext,
        includeOwnerNote,
        ownerNote,
      });
      return {
        bundle,
        error: null,
        exactPreview: serializeSupportBundle(bundle),
      };
    } catch (caught) {
      return {
        bundle: null,
        error:
          caught instanceof Error
            ? caught.message
            : "The local bundle could not be prepared.",
        exactPreview: null,
      };
    }
  }, [
    appVersion,
    includeDiagnosticContext,
    includeOwnerNote,
    observedState,
    ownerNote,
    prepared,
    problemType,
  ]);

  function selectProblem(next: SupportProblemType) {
    setProblemType(next);
    setObservedState(firstObservedState(next));
    setPrepared(null);
    setPrepareError(null);
  }

  function preparePreview() {
    setPrepareError(null);
    try {
      setPrepared({
        correlationId: crypto.randomUUID(),
        generatedAt: new Date().toISOString(),
        diagnosticContext: collectBrowserSupportContext(),
      });
    } catch {
      setPrepared(null);
      setPrepareError(
        "Repbook could not create a local bundle identity. Nothing was exported.",
      );
    }
  }

  function download() {
    if (!rendered.bundle || rendered.exactPreview == null) return;
    const url = URL.createObjectURL(
      new Blob([rendered.exactPreview], {
        type: "application/json;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = supportBundleFilename(rendered.bundle);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const problem = SUPPORT_PROBLEMS[problemType];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Choose the problem</CardTitle>
          <CardDescription>
            Each problem has its own minimum allowlist. Changing the problem
            discards the current preview and creates no saved record.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Problem type</legend>
            {Object.entries(SUPPORT_PROBLEMS).map(([value, option]) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-primary/5"
              >
                <input
                  type="radio"
                  name="support-problem"
                  value={value}
                  checked={problemType === value}
                  onChange={() => selectProblem(value as SupportProblemType)}
                  className="mt-1 size-4"
                />
                <span>
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">What happened?</legend>
            {Object.entries(problem.observedStates).map(([value, label]) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-primary/5"
              >
                <input
                  type="radio"
                  name="support-outcome"
                  value={value}
                  checked={observedState === value}
                  onChange={() => {
                    setObservedState(value);
                    setPrepared(null);
                    setPrepareError(null);
                  }}
                  className="mt-1 size-4"
                />
                <span className="text-sm leading-5">{label}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Optional sections</legend>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3">
              <input
                type="checkbox"
                checked={includeDiagnosticContext}
                onChange={(event) =>
                  setIncludeDiagnosticContext(event.target.checked)
                }
                className="mt-1 size-4"
              />
              <span>
                <span className="block text-sm font-medium">
                  Include coarse browser context
                </span>
                <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                  Only the fields allowlisted for this problem are used. Repbook
                  never includes the full browser string, account identity, or
                  workout contents.
                </span>
              </span>
            </label>

            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3">
              <input
                type="checkbox"
                checked={includeOwnerNote}
                onChange={(event) => setIncludeOwnerNote(event.target.checked)}
                className="mt-1 size-4"
              />
              <span>
                <span className="block text-sm font-medium">
                  Include my optional note
                </span>
                <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                  Off by default. Anything you type may contain private training
                  or health details and will be plainly labelled in the preview.
                </span>
              </span>
            </label>

            {includeOwnerNote ? (
              <label className="block text-sm font-medium">
                Optional owner-written note
                <Textarea
                  className="mt-2 min-h-28"
                  value={ownerNote}
                  maxLength={500}
                  onChange={(event) => setOwnerNote(event.target.value)}
                  placeholder="Describe only what you deliberately want in the exported file."
                />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {ownerNote.length}/500 characters
                </span>
              </label>
            ) : null}
          </fieldset>

          <div className="rounded-lg border bg-muted/35 p-4 text-sm leading-6">
            <div className="flex gap-3">
              <ShieldCheck
                className="mt-0.5 size-5 shrink-0 text-primary"
                aria-hidden="true"
              />
              <div>
                <p className="font-medium">Local preview and download only</p>
                <p className="text-muted-foreground">
                  Preparing this bundle makes no upload, API, AI, or persistence
                  request. It does not read retained server logs or reuse an
                  analysis package. You decide whether to share the downloaded
                  file later.
                </p>
              </div>
            </div>
          </div>

          {prepareError || rendered.error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {prepareError ?? rendered.error}
            </p>
          ) : null}

          <Button
            type="button"
            onClick={preparePreview}
            className="min-h-11"
          >
            Prepare exact local preview
          </Button>
        </CardContent>
      </Card>

      {rendered.bundle && rendered.exactPreview ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileCheck2 className="size-5 text-primary" aria-hidden="true" />
              Exact support bundle preview
            </CardTitle>
            <CardDescription>
              Optional-section changes update these exact bytes before download.
              Schema {SUPPORT_BUNDLE_SCHEMA_VERSION}; redaction {" "}
              {SUPPORT_BUNDLE_REDACTION_VERSION}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <pre
              data-testid="support-bundle-preview"
              className="max-h-[32rem] max-w-full overflow-auto whitespace-pre rounded-lg border bg-muted/35 p-3 text-xs leading-5"
              tabIndex={0}
            >
              {rendered.exactPreview}
            </pre>
            <Button type="button" onClick={download} className="min-h-11">
              <Download className="size-4" aria-hidden="true" />
              Download exact support bundle
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
