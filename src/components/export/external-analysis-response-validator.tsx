"use client";

import {
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Download, FileJson2, ShieldAlert, Trash2 } from "lucide-react";
import {
  EXTERNAL_ANALYSIS_RESPONSE_MAX_BYTES,
  type ExternalAnalysisResponse,
  type ExternalAnalysisResponseIssue,
} from "@/lib/external-analysis-response";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ValidationResult = {
  preview: ExternalAnalysisResponse;
  effectSummary: Array<{
    proposalId: string;
    type: string;
    scope: string;
    targetKind: string;
  }>;
  retained: false;
  imported: false;
};

const ACCEPTED_FILE_TYPES = new Set(["", "application/json", "text/json"]);

function responseFilename(raw: string) {
  try {
    const value = JSON.parse(raw) as { responseId?: unknown };
    if (typeof value.responseId === "string") {
      return `repbook-external-response-${value.responseId}.json`;
    }
  } catch {
    // The original malformed input remains downloadable for recovery.
  }
  return "repbook-external-response-recovery.json";
}

export function ExternalAnalysisResponseValidator() {
  const [rawInput, setRawInput] = useState("");
  const [sourceLabel, setSourceLabel] = useState<"paste" | "file">("paste");
  const [preview, setPreview] = useState<ValidationResult | null>(null);
  const [issues, setIssues] = useState<ExternalAnalysisResponseIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedObservationIds, setSelectedObservationIds] = useState<string[]>([]);
  const [selectedProposalIds, setSelectedProposalIds] = useState<string[]>([]);
  const [imported, setImported] = useState<{
    observationCount: number;
    proposalCount: number;
    replay: "new" | "idempotent_duplicate";
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function clearValidation() {
    setPreview(null);
    setIssues([]);
    setError(null);
    setSelectedObservationIds([]);
    setSelectedProposalIds([]);
    setImported(null);
  }

  async function chooseFile(file: File | undefined) {
    clearValidation();
    if (!file) return;
    const isJsonName = file.name.toLowerCase().endsWith(".json");
    if (!isJsonName || !ACCEPTED_FILE_TYPES.has(file.type)) {
      setError("Choose a .json response file. Other file types are not accepted.");
      return;
    }
    if (file.size > EXTERNAL_ANALYSIS_RESPONSE_MAX_BYTES) {
      setError("The response file is larger than the supported 256 KiB limit.");
      return;
    }
    try {
      setRawInput(await file.text());
      setSourceLabel("file");
    } catch {
      setError("The response file could not be read locally.");
    }
  }

  async function validate() {
    clearValidation();
    if (new TextEncoder().encode(rawInput).byteLength > EXTERNAL_ANALYSIS_RESPONSE_MAX_BYTES) {
      setError("The response is larger than the supported 256 KiB limit.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/export/analysis/validate", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/vnd.repbook.analysis-response+json",
        },
        body: rawInput,
      });
      const data = (await response.json()) as Partial<ValidationResult> & {
        error?: string;
        issues?: ExternalAnalysisResponseIssue[];
      };
      if (!response.ok || !data.preview || !data.effectSummary) {
        setIssues(data.issues ?? []);
        throw new Error(data.error ?? "The response could not be validated.");
      }
      setPreview(data as ValidationResult);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The response could not be validated.",
      );
    } finally {
      setLoading(false);
    }
  }

  function downloadOriginal() {
    if (!rawInput) return;
    const url = URL.createObjectURL(
      new Blob([rawInput], { type: "application/json;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = responseFilename(rawInput);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function discard() {
    setRawInput("");
    setSourceLabel("paste");
    clearValidation();
    if (fileInput.current) fileInput.current.value = "";
  }

  function toggleSelection(
    id: string,
    setSelected: Dispatch<SetStateAction<string[]>>,
  ) {
    setSelected((selected) =>
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id],
    );
  }

  async function importSelected() {
    if (!preview || selectedObservationIds.length + selectedProposalIds.length === 0) return;
    setError(null);
    setImporting(true);
    try {
      const response = await fetch("/api/export/analysis/import", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          response: JSON.parse(rawInput),
          selections: {
            observationIds: selectedObservationIds,
            proposalIds: selectedProposalIds,
          },
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        observationCount?: number;
        proposalCount?: number;
        replay?: "new" | "idempotent_duplicate";
      };
      if (
        !response.ok ||
        data.observationCount == null ||
        data.proposalCount == null ||
        data.replay == null
      ) {
        throw new Error(data.error ?? "The selected items could not be imported.");
      }
      setImported({
        observationCount: data.observationCount,
        proposalCount: data.proposalCount,
        replay: data.replay,
      });
      setRawInput("");
      setPreview(null);
      setIssues([]);
      setSelectedObservationIds([]);
      setSelectedProposalIds([]);
      if (fileInput.current) fileInput.current.value = "";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The selected items could not be imported.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Card data-testid="external-analysis-validator">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileJson2 className="size-5 text-primary" aria-hidden="true" />
          Validate a returned response
        </CardTitle>
        <CardDescription>
          Paste JSON or choose a JSON file. Repbook checks the exact owner-scoped
          package receipt, expiry, current Program, evidence, units, and effects
          before showing a preview. Validation imports nothing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-lg border bg-muted/35 p-4 text-sm leading-6">
          <div className="flex gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <p className="font-medium">Untrusted input stays transient</p>
              <p className="text-muted-foreground">
                The original text remains only in this browser page so you can
                download or retry it. The server does not retain the response,
                and no observation or proposal enters Review yet.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div className="space-y-2">
            <label htmlFor="external-analysis-response" className="text-sm font-medium">
              Returned JSON
            </label>
            <textarea
              id="external-analysis-response"
              value={rawInput}
              onChange={(event) => {
                setRawInput(event.target.value);
                setSourceLabel("paste");
                clearValidation();
              }}
              rows={12}
              spellCheck={false}
              placeholder="Paste the complete repbook-analysis-response JSON here"
              className="min-h-64 w-full resize-y rounded-md border bg-background p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="external-analysis-file" className="text-sm font-medium">
              Or choose a file
            </label>
            <input
              ref={fileInput}
              id="external-analysis-file"
              type="file"
              accept=".json,application/json"
              onChange={(event) => void chooseFile(event.target.files?.[0])}
              className="block min-h-11 max-w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:bg-background file:px-3 file:text-sm file:font-medium"
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Current source: {sourceLabel === "file" ? "local JSON file" : "pasted text"}. Maximum 256 KiB.
        </p>

        {error ? (
          <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">{error}</p>
            <p className="text-muted-foreground">
              Keep this input for recovery, or prepare a new analysis package and
              regenerate the response when the receipt is missing, expired, or stale.
            </p>
          </div>
        ) : null}

        {issues.length > 0 ? (
          <details className="rounded-md border p-3 text-sm">
            <summary className="cursor-pointer font-medium">Validation details</summary>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {issues.map((issue, index) => (
                <li key={`${issue.code}-${issue.path}-${index}`}>
                  {issue.path || "response"}: {issue.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {imported ? (
          <div role="status" className="rounded-md border border-success/40 bg-success/5 p-3 text-sm">
            <p className="font-medium">Selected items are in Review</p>
            <p className="mt-1 text-muted-foreground">
              {imported.observationCount} observation{imported.observationCount === 1 ? "" : "s"} and {imported.proposalCount} proposal{imported.proposalCount === 1 ? "" : "s"} were {imported.replay === "new" ? "imported" : "already imported"}. The raw response was discarded.
            </p>
            <a className="mt-2 inline-flex min-h-10 items-center text-primary underline-offset-2 hover:underline" href="/coach">
              Open Review and decisions
            </a>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void validate()} disabled={loading || rawInput.length === 0} className="min-h-11">
            {loading ? "Validating…" : "Validate and preview"}
          </Button>
          <Button type="button" variant="outline" onClick={downloadOriginal} disabled={!rawInput} className="min-h-11">
            <Download className="size-4" aria-hidden="true" />
            Download original input
          </Button>
          <Button type="button" variant="ghost" onClick={discard} disabled={!rawInput && !error} className="min-h-11">
            <Trash2 className="size-4" aria-hidden="true" />
            Discard transient input
          </Button>
        </div>

        {preview ? (
          <section aria-labelledby="external-analysis-preview-title" aria-live="polite" data-testid="external-analysis-preview" className="space-y-5 rounded-lg border p-4">
            <div>
              <h3 id="external-analysis-preview-title" className="font-semibold">
                Validated preview only
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Response {preview.preview.responseId}. Nothing was retained,
                imported, accepted, or applied.
              </p>
            </div>

            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Observations</h4>
              {preview.preview.observations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No observations returned.</p>
              ) : (
                <ul className="space-y-3">
                  {preview.preview.observations.map((observation) => (
                    <li key={observation.id} className="rounded-md border bg-muted/20 p-3 text-sm leading-6">
                      <label className="mb-2 flex min-h-11 cursor-pointer items-center gap-2 font-medium">
                        <input
                          type="checkbox"
                          checked={selectedObservationIds.includes(observation.id)}
                          onChange={() => toggleSelection(observation.id, setSelectedObservationIds)}
                        />
                        Import this labelled external observation
                      </label>
                      <p className="font-medium">{observation.statement}</p>
                      <p className="text-muted-foreground">Evidence: {observation.evidenceIds.join(", ")}</p>
                      <p className="text-muted-foreground">Limits: {observation.limitations.join(" · ")}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Proposed future Review items</h4>
              {preview.preview.proposedActions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No proposals returned.</p>
              ) : (
                <ul className="space-y-3">
                  {preview.preview.proposedActions.map((proposal) => (
                    <li key={proposal.id} className="rounded-md border bg-muted/20 p-3 text-sm leading-6">
                      <label className="mb-2 flex min-h-11 cursor-pointer items-center gap-2 font-medium">
                        <input
                          type="checkbox"
                          checked={selectedProposalIds.includes(proposal.id)}
                          onChange={() => toggleSelection(proposal.id, setSelectedProposalIds)}
                        />
                        Import this proposal into Review
                      </label>
                      <p className="font-medium">{proposal.summary}</p>
                      <p>{proposal.rationale}</p>
                      <p className="text-muted-foreground">
                        Effect: {proposal.effect.type} · {proposal.effect.scope} · {proposal.effect.target.kind}
                      </p>
                      <p className="text-muted-foreground">Evidence: {proposal.evidenceIds.join(", ")}</p>
                      <p className="text-muted-foreground">Limits: {proposal.limitations.join(" · ")}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {preview.preview.unknowns.length > 0 ? (
              <div className="space-y-3">
                <h4 className="text-sm font-semibold">Unknown or unsupported</h4>
                <ul className="space-y-2">
                  {preview.preview.unknowns.map((unknown) => (
                    <li key={unknown.id} className="rounded-md border p-3 text-sm leading-6">
                      <p className="font-medium">{unknown.question}</p>
                      <p className="text-muted-foreground">{unknown.reason}: {unknown.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-sm font-medium">Import only what you selected</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Import retains the selected allowlisted items and a provenance receipt, then deletes the temporary package manifest. It does not accept a proposal or change your Program.
              </p>
              <Button
                type="button"
                className="mt-3 min-h-11 w-full sm:w-auto"
                disabled={importing || selectedObservationIds.length + selectedProposalIds.length === 0}
                onClick={() => void importSelected()}
              >
                {importing ? "Importing…" : "Import selected into Review"}
              </Button>
            </div>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
