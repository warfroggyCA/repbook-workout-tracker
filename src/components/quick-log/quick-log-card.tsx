"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  parseQuickLog,
  applyQuickLog,
  type QuickLogParseResponse,
} from "@/app/actions/quick-log";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Check, Mic, X } from "lucide-react";
import {
  INCOMPLETE_SESSION_REASONS,
  INCOMPLETE_SESSION_REASON_LABELS,
  type IncompleteSessionReason,
} from "@/lib/session-completion-semantics";

type ParseOk = Extract<QuickLogParseResponse, { ok: true }>;

export function QuickLogCard() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [parsed, setParsed] = useState<ParseOk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [severities, setSeverities] = useState<Record<string, number>>({});
  const [skipReasons, setSkipReasons] = useState<
    Record<string, IncompleteSessionReason>
  >({});
  const [discarded, setDiscarded] = useState<number[]>([]);
  const [pending, startTransition] = useTransition();

  function reset() {
    setParsed(null);
    setChoices({});
    setSeverities({});
    setSkipReasons({});
    setDiscarded([]);
    setError(null);
  }

  function handleParse() {
    setError(null);
    startTransition(async () => {
      const result = await parseQuickLog(input);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setParsed(result);
      // Pre-fill auto-resolved exercises; the user can still change them
      const auto: Record<string, string> = {};
      result.resolutions.forEach((r, i) => {
        if (r.exerciseId) auto[String(i)] = r.exerciseId;
      });
      setChoices(auto);
    });
  }

  function handleSave() {
    if (!parsed) return;
    setError(null);
    startTransition(async () => {
      const result = await applyQuickLog({
        parsingEventId: parsed.parsingEventId,
        exerciseByEntry: choices,
        discardedEntries: discarded,
        painSeverityByEntry: severities,
        skipReasonByEntry: skipReasons,
      });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setInput("");
      reset();
      router.refresh();
    });
  }

  if (!parsed) {
    return (
      <div className="rounded-xl border p-3">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          <Mic className="size-3.5" /> Quick log
        </p>
        <Textarea
          placeholder={'e.g. "Bench 135 for 8, 8, 7. Last set was hard. Slight shoulder pinch."'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Type or dictate. You&apos;ll confirm what was understood before
          anything is saved.
        </p>
        {error && (
          <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}
        <Button
          size="sm"
          className="mt-2"
          disabled={pending || !input.trim()}
          onClick={handleParse}
        >
          {pending ? "Parsing…" : "Parse"}
        </Button>
      </div>
    );
  }

  const entries = parsed.envelope.data.entries;
  const hasUnconfirmedSkipReason = entries.some(
    (entry, index) =>
      entry.kind === "skip" &&
      !discarded.includes(index) &&
      !skipReasons[String(index)],
  );

  return (
    <div className="rounded-xl border border-primary/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium">Confirm before saving</p>
        <Badge variant="outline">
          {parsed.source === "regex" ? "parsed locally" : "parsed by AI"}
        </Badge>
      </div>

      {parsed.envelope.clarifyingQuestions.length > 0 && (
        <ul className="mb-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {parsed.envelope.clarifyingQuestions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        {entries.map((entry, idx) => {
          const isDiscarded = discarded.includes(idx);
          const resolution = parsed.resolutions[idx];
          return (
            <div
              key={idx}
              className={cn(
                "rounded-md border p-2 text-sm",
                isDiscarded && "opacity-40"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {entry.kind === "sets" && (
                    <>
                      <p className="font-medium">
                        {entry.rawExercise}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {entry.sets
                            .map((s) =>
                              s.weight != null ? `${s.weight}×${s.reps}` : `${s.reps}`
                            )
                            .join(", ")}
                        </span>
                      </p>
                      {!isDiscarded &&
                        (resolution.matchType !== "none" ? (
                          <p className="text-xs text-green-700 dark:text-green-400">
                            → {resolution.exerciseName}
                          </p>
                        ) : (
                          <select
                            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-xs"
                            value={choices[String(idx)] ?? ""}
                            onChange={(e) =>
                              setChoices((c) => ({ ...c, [String(idx)]: e.target.value }))
                            }
                          >
                            <option value="">Match to exercise…</option>
                            {resolution.candidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        ))}
                    </>
                  )}
                  {entry.kind === "skip" && (
                    <div>
                      <p>
                        <Badge variant="outline">skipped</Badge>{" "}
                        {entry.rawExercise}
                      </p>
                      {entry.reasonCode && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Parsed suggestion:{" "}
                          {INCOMPLETE_SESSION_REASON_LABELS[entry.reasonCode]}
                        </p>
                      )}
                      {!isDiscarded && (
                        <label className="mt-2 block text-xs font-medium">
                          Skip reason
                          <select
                            aria-label={`${entry.rawExercise} skip reason`}
                            className="mt-1 min-h-10 w-full rounded-md border bg-background px-2 py-1 text-xs"
                            value={skipReasons[String(idx)] ?? ""}
                            onChange={(event) =>
                              setSkipReasons((current) => {
                                const next = { ...current };
                                if (event.target.value) {
                                  next[String(idx)] = event.target
                                    .value as IncompleteSessionReason;
                                } else {
                                  delete next[String(idx)];
                                }
                                return next;
                              })
                            }
                          >
                            <option value="">Choose a reason</option>
                            {INCOMPLETE_SESSION_REASONS.map((reason) => (
                              <option key={reason} value={reason}>
                                {INCOMPLETE_SESSION_REASON_LABELS[reason]}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                  {entry.kind === "pain" && (
                    <div>
                      <p>
                        <Badge variant="destructive">pain</Badge> {entry.bodyPart}
                        {entry.severity != null ? ` ${entry.severity}/10` : ""}
                      </p>
                      {entry.severity == null && !isDiscarded && (
                        <label className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          Severity:
                          <input
                            type="range"
                            min={0}
                            max={10}
                            value={severities[String(idx)] ?? 2}
                            onChange={(e) =>
                              setSeverities((s) => ({
                                ...s,
                                [String(idx)]: Number(e.target.value),
                              }))
                            }
                          />
                          <span className="font-medium text-foreground">
                            {severities[String(idx)] ?? 2}/10
                          </span>
                        </label>
                      )}
                    </div>
                  )}
                  {entry.kind === "note" && (
                    <p className="text-muted-foreground">&ldquo;{entry.text}&rdquo;</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={isDiscarded ? "Keep entry" : "Discard entry"}
                  onClick={() =>
                    setDiscarded((d) =>
                      d.includes(idx) ? d.filter((i) => i !== idx) : [...d, idx]
                    )
                  }
                >
                  {isDiscarded ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {parsed.envelope.unparsed.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Couldn&apos;t place: {parsed.envelope.unparsed.join(" · ")}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          className="flex-1"
          disabled={pending || hasUnconfirmedSkipReason}
          onClick={handleSave}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="outline" onClick={reset}>
          Edit text
        </Button>
      </div>
    </div>
  );
}
