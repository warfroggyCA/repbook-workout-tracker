"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy, Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  COMPLETE_REPORT_PREPARE_TIMEOUT_MS,
  readCompleteReportForCopy,
} from "@/lib/complete-report-copy";

type CopyState = "idle" | "loading" | "ready" | "copying" | "copied" | "error";

export function CopyCompleteReportButton() {
  const [state, setState] = useState<CopyState>("idle");
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const copying = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);

  async function prepareReport() {
    if (pending.current || copying.current) return;
    setReport(null);
    const controller = new AbortController();
    pending.current = controller;
    setState("loading");
    setMessage("Preparing your complete report. This can take up to 30 seconds…");
    const timeout = window.setTimeout(() => controller.abort(), COMPLETE_REPORT_PREPARE_TIMEOUT_MS);
    try {
      const response = await fetch("/api/export/llm-report", {
        cache: "no-store",
        headers: { Accept: "text/markdown" },
        signal: controller.signal,
      });
      const prepared = await readCompleteReportForCopy(response);
      if (!mounted.current || controller.signal.aborted) return;
      setReport(prepared.text);
      setState("ready");
      setMessage(`Complete report ready (${Math.ceil(prepared.bytes / 1024)} KB). Tap Copy report to place it on your clipboard.`);
    } catch (error) {
      if (!mounted.current) return;
      setState("error");
      setMessage(controller.signal.aborted
        ? "Report preparation took too long. Try again or download the complete report file."
        : error instanceof Error ? error.message : "The report could not be prepared. Try again.");
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
    }
  }

  async function copyReport() {
    if (copying.current || report == null) return;
    copying.current = true;
    setState("copying");
    setMessage("Copying report…");
    let timeout: number | undefined;
    try {
      // Both APIs are called directly in this new tap, with already prepared data.
      const clipboard = navigator.clipboard as Partial<Clipboard> | undefined;
      const operation = clipboard?.write && typeof ClipboardItem !== "undefined"
        ? clipboard.write([new ClipboardItem({ "text/plain": new Blob([report], { type: "text/plain" }) })])
        : clipboard?.writeText?.(report);
      if (!operation) throw new Error("unavailable");
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error("timeout")), 10_000);
        }),
      ]);
      if (!mounted.current) return;
      setReport(null);
      setState("copied");
      setMessage("Complete report copied to your clipboard.");
    } catch {
      if (!mounted.current) return;
      setState("error");
      setMessage("Copying was not confirmed. Allow clipboard access and try Copy report again, or download the complete report file.");
    } finally {
      window.clearTimeout(timeout);
      copying.current = false;
    }
  }

  return (
    <div className="space-y-3">
      <a className={cn(buttonVariants({ size: "lg" }), "h-auto min-h-12 w-full whitespace-normal py-3 text-base")}
        href="/api/export/llm-report?download=1">
          <Download className="size-5" aria-hidden="true" />
          <span className="min-w-0">Download complete report</span>
      </a>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="h-auto min-h-12 w-full whitespace-normal py-3 text-base"
        disabled={state === "loading" || state === "copying"}
        onClick={() => void (report == null ? prepareReport() : copyReport())}
      >
        {state === "copied" ? <Check className="size-5" aria-hidden="true" /> : <ClipboardCopy className="size-5" aria-hidden="true" />}
        {state === "loading" ? "Preparing report…" : state === "copying" ? "Copying report…" : report != null ? "Copy report" : "Prepare report for copying"}
      </Button>
      <p className={state === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        role={state === "error" ? "alert" : "status"} aria-live="polite">
        {message || "Download the complete file, or prepare a clipboard copy. Large reports are available as downloads. Repbook does not send them anywhere."}
      </p>
    </div>
  );
}
