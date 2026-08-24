"use client";

import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { Button } from "@/components/ui/button";

type CopyState = "idle" | "loading" | "copied" | "error";

async function responseText(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      response.status === 429
        ? text
        : "The report could not be prepared. Try again.",
    );
  }
  return text;
}

export function CopyCompleteReportButton() {
  const [state, setState] = useState<CopyState>("idle");
  const [message, setMessage] = useState("");

  async function copyReport() {
    if (
      !navigator.clipboard ||
      (!navigator.clipboard.write && !navigator.clipboard.writeText)
    ) {
      setState("error");
      setMessage("Clipboard access is unavailable in this browser.");
      return;
    }

    setState("loading");
    setMessage("Preparing your complete report…");
    try {
      const reportPromise = fetch("/api/export/llm-report", {
        cache: "no-store",
        headers: { Accept: "text/markdown" },
      }).then(responseText);
      if (
        navigator.clipboard.write &&
        typeof ClipboardItem !== "undefined"
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": reportPromise.then(
              (report) => new Blob([report], { type: "text/plain" }),
            ),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(await reportPromise);
      }
      setState("copied");
      setMessage("Complete report copied to your clipboard.");
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "The report could not be copied. Try again.",
      );
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="lg"
        className="h-auto min-h-12 w-full whitespace-normal py-3 text-base"
        disabled={state === "loading"}
        onClick={() => void copyReport()}
      >
        {state === "copied" ? (
          <Check className="size-5" aria-hidden="true" />
        ) : (
          <ClipboardCopy className="size-5" aria-hidden="true" />
        )}
        {state === "loading"
          ? "Preparing report…"
          : state === "copied"
            ? "Report copied"
            : "Create complete report & copy"}
      </Button>
      <p
        className={
          state === "error"
            ? "text-sm text-destructive"
            : "text-sm text-muted-foreground"
        }
        role={state === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        {message || "Copies the report to this device. Repbook does not send it anywhere."}
      </p>
    </div>
  );
}
