"use client";

import { useState } from "react";
import {
  Check,
  ClipboardCopy,
  Download,
  FileCheck2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  ANALYSIS_PACKAGE_SCHEMA_VERSION,
  ANALYSIS_QUESTIONS,
  type AnalysisPackage,
  type AnalysisPackageManifestSummary,
  type AnalysisQuestionId,
} from "@/lib/analysis-package";
import {
  buildExternalAnalysisInstructions,
  EXTERNAL_ANALYSIS_INSTRUCTION_VERSION,
  externalAnalysisInstructionsFilename,
} from "@/lib/external-analysis-instructions";
import {
  EXTERNAL_ANALYSIS_RESPONSE_SCHEMA_VERSION,
} from "@/lib/external-analysis-versions";
import { Button } from "@/components/ui/button";
import { ExternalAnalysisResponseValidator } from "@/components/export/external-analysis-response-validator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const WINDOW_OPTIONS = [
  { value: 28, label: "4 weeks" },
  { value: 84, label: "12 weeks" },
  { value: 182, label: "26 weeks" },
] as const;

type WindowDays = (typeof WINDOW_OPTIONS)[number]["value"];

function packageFilename(value: AnalysisPackage) {
  return `repbook-analysis-${value.request.questionId}-${value.evidenceCutoff.slice(0, 10)}.json`;
}

export function AnalysisPackageBuilder({
  initialManifests,
}: {
  initialManifests: AnalysisPackageManifestSummary[];
}) {
  const [questionId, setQuestionId] =
    useState<AnalysisQuestionId>("program_progress");
  const [windowDays, setWindowDays] = useState<WindowDays>(84);
  const [exactPreview, setExactPreview] = useState<string | null>(null);
  const [packageValue, setPackageValue] = useState<AnalysisPackage | null>(null);
  const [manifests, setManifests] =
    useState<AnalysisPackageManifestSummary[]>(initialManifests);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  async function refreshManifests() {
    const response = await fetch("/api/export/analysis", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error("The retained package manifests could not be refreshed.");
    }
    const data = (await response.json()) as {
      manifests?: AnalysisPackageManifestSummary[];
    };
    setManifests(data.manifests ?? []);
  }

  async function generate() {
    setLoading(true);
    setError(null);
    setExactPreview(null);
    setPackageValue(null);
    setCopyStatus("idle");
    try {
      const response = await fetch("/api/export/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ questionId, windowDays }),
      });
      const data = (await response.json()) as {
        package?: AnalysisPackage;
        error?: string;
      };
      if (!response.ok || !data.package) {
        throw new Error(data.error ?? "The package could not be prepared.");
      }
      const serialized = `${JSON.stringify(data.package, null, 2)}\n`;
      setPackageValue(data.package);
      setExactPreview(serialized);
      await refreshManifests();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The package could not be prepared.",
      );
    } finally {
      setLoading(false);
    }
  }

  function download() {
    if (!packageValue || exactPreview == null) return;
    const url = URL.createObjectURL(
      new Blob([exactPreview], { type: "application/json;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = packageFilename(packageValue);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyJson() {
    if (exactPreview == null) return;
    if (!navigator.clipboard?.writeText) {
      setCopyStatus("error");
      return;
    }
    try {
      await navigator.clipboard.writeText(exactPreview);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  function downloadInstructions() {
    if (!packageValue) return;
    const instructions = buildExternalAnalysisInstructions(packageValue);
    const url = URL.createObjectURL(
      new Blob([instructions], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = externalAnalysisInstructionsFilename(packageValue);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function deleteManifest(id: string) {
    setError(null);
    try {
      const response = await fetch(`/api/export/analysis/${id}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "The manifest could not be deleted.");
      }
      if (packageValue?.packageId === id) {
        setPackageValue(null);
        setExactPreview(null);
        setCopyStatus("idle");
      }
      await refreshManifests();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The manifest could not be deleted.",
      );
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Choose one analysis purpose</CardTitle>
          <CardDescription>
            The closed question and evidence window determine what is included.
            Unknown historical meaning stays unknown.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Question</legend>
            {Object.entries(ANALYSIS_QUESTIONS).map(([value, option]) => (
              <label
                key={value}
                className="flex cursor-pointer gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-primary/5"
              >
                <input
                  type="radio"
                  name="analysis-question"
                  value={value}
                  checked={questionId === value}
                  onChange={() => setQuestionId(value as AnalysisQuestionId)}
                  className="mt-1 size-4"
                />
                <span>
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                    {option.question}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Evidence window</legend>
            <div className="flex flex-wrap gap-2">
              {WINDOW_OPTIONS.map((option) => (
                <label key={option.value} className="cursor-pointer">
                  <input
                    type="radio"
                    name="analysis-window"
                    value={option.value}
                    checked={windowDays === option.value}
                    onChange={() => setWindowDays(option.value)}
                    className="peer sr-only"
                  />
                  <span className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
                    {option.label}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="rounded-lg border bg-muted/35 p-4 text-sm leading-6">
            <div className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <p className="font-medium">Nothing is transmitted automatically.</p>
                <p className="text-muted-foreground">
                  Repbook retains a digest and source manifest for 30 days, not
                  the detailed package. Account identity, raw AI/provider data,
                  private notes, archives, and recovery records are excluded.
                </p>
              </div>
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button onClick={generate} disabled={loading} className="min-h-11">
            {loading ? "Preparing package…" : "Prepare exact preview"}
          </Button>
        </CardContent>
      </Card>

      {packageValue && exactPreview ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileCheck2 className="size-5 text-primary" aria-hidden="true" />
                Exact package preview
              </CardTitle>
              <CardDescription>
                The downloaded file uses these exact bytes. Schema {packageValue.schemaVersion};
                digest {packageValue.integrity.digest.slice(0, 16)}…
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <pre
                data-testid="analysis-package-preview"
                className="max-h-[32rem] max-w-full overflow-auto whitespace-pre rounded-lg border bg-muted/35 p-3 text-xs leading-5"
                tabIndex={0}
              >
                {exactPreview}
              </pre>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void copyJson()} className="min-h-11">
                  {copyStatus === "copied" ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <ClipboardCopy className="size-4" aria-hidden="true" />
                  )}
                  {copyStatus === "copied" ? "JSON copied" : "Copy JSON"}
                </Button>
                <Button onClick={download} variant="outline" className="min-h-11">
                  <Download className="size-4" aria-hidden="true" />
                  Download exact JSON
                </Button>
              </div>
              <p
                className={copyStatus === "error" ? "text-sm text-destructive" : "sr-only"}
                role={copyStatus === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {copyStatus === "copied"
                  ? "Exact JSON copied to your clipboard."
                  : copyStatus === "error"
                    ? "Clipboard access was denied or is unavailable."
                    : ""}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Provider-neutral instructions</CardTitle>
              <CardDescription>
                Use the same complete instructions with ChatGPT or another capable
                language model. They bind the exact package, forbid guessed facts
                and direct mutation, and require evidence IDs and limitations.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border bg-muted/35 p-4 text-sm leading-6">
                <p className="font-medium">Typed, but still untrusted</p>
                <p className="text-muted-foreground">
                  Repbook can define and validate the response contract, but the
                  paste/upload validator below can now check this exact package
                  receipt and show a transient preview. It still cannot import,
                  accept, or apply anything. Review the external provider&apos;s
                  privacy and retention settings before sharing this package.
                </p>
              </div>
              <pre
                data-testid="external-analysis-instructions"
                className="max-h-[32rem] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/35 p-3 text-xs leading-5"
                tabIndex={0}
              >
                {buildExternalAnalysisInstructions(packageValue)}
              </pre>
              <Button onClick={downloadInstructions} variant="outline" className="min-h-11">
                <Download className="size-4" aria-hidden="true" />
                Download model instructions
              </Button>
              <p className="text-xs leading-5 text-muted-foreground">
                Instruction contract: {EXTERNAL_ANALYSIS_INSTRUCTION_VERSION} ·
                response schema: {EXTERNAL_ANALYSIS_RESPONSE_SCHEMA_VERSION}.
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}

      <ExternalAnalysisResponseValidator />

      <Card>
        <CardHeader>
          <CardTitle>Retained package manifests</CardTitle>
          <CardDescription>
            These receipts contain versions, digest, scope, inventory, and
            source bindings—not the package contents. Deletion removes the
            receipt; expired manifests cannot support a later import.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {manifests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No package manifests retained.</p>
          ) : (
            <ul className="space-y-3">
              {manifests.map((manifest) => (
                <li key={manifest.id} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {ANALYSIS_QUESTIONS[manifest.questionId as AnalysisQuestionId]?.label ?? manifest.questionId}
                      {" · "}{manifest.windowDays} days
                    </p>
                    <p className="break-all text-xs leading-5 text-muted-foreground">
                      {manifest.schemaVersion} · {manifest.digest} · {manifest.status}
                    </p>
                  </div>
                  {manifest.status === "active" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void deleteManifest(manifest.id)}
                      aria-label={`Delete manifest ${manifest.digest.slice(0, 12)}`}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      Delete manifest
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Current package contract: {ANALYSIS_PACKAGE_SCHEMA_VERSION}.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
