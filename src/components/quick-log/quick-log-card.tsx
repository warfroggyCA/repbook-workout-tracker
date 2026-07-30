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

type ParseOk = Extract<QuickLogParseResponse, { ok: true }>;

export function QuickLogCard() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [parsed, setParsed] = useState<ParseOk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [severities, setSeverities] = useState<Record<string, number>>({});
  const [discarded, setDiscarded] = useState<number[]>([]);
  const [pending, startTransition] = useTransition();

  function reset() {
    setParsed(null);
    setChoices({});
    setSeverities({});
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
                    <p>
                      <Badge variant="outline">skipped</Badge> {entry.rawExercise}
                      {entry.reason ? ` (${entry.reason})` : ""}
                    </p>
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
        <Button size="sm" className="flex-1" disabled={pending} onClick={handleSave}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="outline" onClick={reset}>
          Edit text
        </Button>
      </div>
    </div>
  );
}
