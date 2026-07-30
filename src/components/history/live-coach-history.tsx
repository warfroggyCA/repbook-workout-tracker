import { AlertTriangle, MessageSquareText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { LiveCoachMessage } from "@/services/live-coaching";

export function LiveCoachHistory({
  messages,
  exerciseNames,
}: {
  messages: LiveCoachMessage[];
  exerciseNames: Record<string, string>;
}) {
  if (!messages.length) return null;
  return (
    <section className="rounded-xl border p-3" aria-labelledby="live-coach-history-title">
      <h2 id="live-coach-history-title" className="mb-1 flex items-center gap-2 text-sm font-medium">
        <MessageSquareText className="size-4 text-primary" /> Workout Coach conversation
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Questions, observations, and replies saved during this workout.
      </p>
      <ol className="flex flex-col gap-2">
        {messages.map((message) => {
          const exerciseName = message.sessionExerciseId
            ? exerciseNames[message.sessionExerciseId]
            : null;
          if (message.author === "user") {
            return (
              <li key={message.id} className="ml-6 rounded-xl bg-primary/8 px-3 py-2 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{message.messageKind === "observation" ? "Observation" : "Question"}</span>
                  {exerciseName && <span>· {exerciseName}</span>}
                  {message.inputMode !== "text" && (
                    <Badge variant="outline">
                      {message.inputMode === "dictation" ? "dictated" : "voice"}
                    </Badge>
                  )}
                </div>
                <p className="whitespace-pre-wrap">{message.content}</p>
              </li>
            );
          }
          if (message.responseStatus !== "completed" || !message.answer) {
            return (
              <li
                key={message.id}
                className="mr-6 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                {message.responseStatus === "pending"
                  ? "Coach reply is still pending."
                  : message.failureReason ?? "Coach could not complete this reply."}
              </li>
            );
          }
          return (
            <li key={message.id} className="mr-6 rounded-xl border bg-card px-3 py-2 text-sm">
              <p className="whitespace-pre-wrap">{message.answer.answer}</p>
              {message.answer.evidence.length > 0 && (
                <div className="mt-2 text-xs text-muted-foreground">
                  <p className="font-medium">Evidence used</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {message.answer.evidence.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {message.answer.safetyNote && (
                <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                  {message.answer.safetyNote}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
