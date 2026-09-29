"use client";
import {
  useRef,
  useState,
  useTransition,
  type ReactNode,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { askCoach, generateTrainingReview } from "@/app/actions/coaching";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function CoachTools({
  aiAvailable,
  hasTrainingData,
  savedReview,
  initialQuestion = "",
  patternKey,
  previousAnswers,
}: {
  aiAvailable: boolean;
  hasTrainingData: boolean;
  savedReview?: ReactNode;
  initialQuestion?: string;
  patternKey?: string;
  previousAnswers?: ReactNode;
}) {
  const router = useRouter();
  const [question, setQuestion] = useState(initialQuestion);
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [action, setAction] = useState<"review" | "ask" | null>(null);
  const [feedback, setFeedback] = useState<{
    action: "review" | "ask";
    error: boolean;
    text: string;
  } | null>(null);
  function run(kind: "review" | "ask") {
    if (busy.current) return;
    busy.current = true;
    setFeedback(null);
    setAction(kind);
    startTransition(async () => {
      try {
        const result =
          kind === "review"
            ? await generateTrainingReview()
            : await askCoach(question, patternKey);
        setFeedback({
          action: kind,
          error: !result.ok,
          text: result.ok
            ? kind === "review"
              ? "Your summary is updated."
              : "Your answer is ready below."
            : result.reason,
        });
        if (result.ok) {
          if (kind === "ask") setQuestion("");
          router.refresh();
        }
      } catch {
        setFeedback({
          action: kind,
          error: true,
          text: "Coach couldn't finish this request. Check your connection and try again.",
        });
      } finally {
        busy.current = false;
        setAction(null);
      }
    });
  }
  function message(kind: "review" | "ask") {
    return feedback?.action === kind ? (
      <p
        role={feedback.error ? "alert" : "status"}
        className={`text-sm ${feedback.error ? "text-destructive" : "text-muted-foreground"}`}
      >
        {feedback.text}
      </p>
    ) : null;
  }
  return (
    <div className="space-y-7">
      <section
        aria-labelledby="training-summary-heading"
        className="space-y-4"
      >
        <h2 id="training-summary-heading" className="ui-section-title">
          Your training summary
        </h2>
        {savedReview ?? (
          <p className="text-sm text-muted-foreground">
            {hasTrainingData
              ? "Get a summary of your recent training when you want one."
              : "Your completed workouts will give Coach something to review."}
          </p>
        )}
        <Button
          onClick={() => run("review")}
          disabled={!aiAvailable || pending || !hasTrainingData}
          className="min-h-11"
          variant={savedReview ? "outline" : "default"}
        >
          {pending && action === "review"
            ? "Updating your summary…"
            : savedReview
              ? "Update summary"
              : "Create summary"}
        </Button>
        {message("review")}
        {!aiAvailable && (
          <p className="text-sm text-muted-foreground">
            Coach is not connected. You can still view and log workouts.
          </p>
        )}
      </section>
      <section
        aria-labelledby="ask-coach-heading"
        className="space-y-3 border-t pt-5"
      >
        <h2 id="ask-coach-heading" className="ui-section-title">
          Ask a question
        </h2>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            run("ask");
          }}
          className="flex flex-col gap-3"
        >
          <label
            htmlFor="coach-question"
            className="text-sm text-muted-foreground"
          >
            What would you like help with?
          </label>
          <Textarea
            id="coach-question"
            aria-label="Question for Coach"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should I focus on next workout?"
            maxLength={600}
            disabled={pending}
            className="min-h-24"
          />
          <Button
            type="submit"
            disabled={!aiAvailable || pending || question.trim().length < 3}
            className="min-h-11 self-start"
          >
            {pending && action === "ask" ? "Thinking…" : "Ask Coach"}
          </Button>
        </form>
        {message("ask")}
        {previousAnswers && (
          <details
            open={feedback?.action === "ask" && !feedback.error}
            className="border-t pt-2"
          >
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-primary">
              Previous questions and answers
            </summary>
            {previousAnswers}
          </details>
        )}
      </section>
    </div>
  );
}
