"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Bot, RefreshCw, Send, Sparkles } from "lucide-react";
import {
  askCoach,
  generateTrainingReview,
} from "@/app/actions/coaching";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

const STARTER_QUESTIONS = [
  "What is progressing most clearly?",
  "Am I recovering well enough?",
  "What should I focus on next workout?",
];

export function CoachTools({
  aiAvailable,
  hasTrainingData,
}: {
  aiAvailable: boolean;
  hasTrainingData: boolean;
}) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [pendingAction, setPendingAction] = useState<"review" | "ask" | null>(
    null
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function runReview() {
    setError(null);
    setMessage(null);
    setPendingAction("review");
    startTransition(async () => {
      try {
        const result = await generateTrainingReview();
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setMessage("Your new training review is ready below.");
        router.refresh();
      } catch {
        setError("Coach could not finish that review. Please try again.");
      } finally {
        setPendingAction(null);
      }
    });
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setPendingAction("ask");
    startTransition(async () => {
      try {
        const result = await askCoach(question);
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setQuestion("");
        setMessage("Coach answered your question below.");
        router.refresh();
      } catch {
        setError("Coach could not answer that question. Please try again.");
      } finally {
        setPendingAction(null);
      }
    });
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
      <Card>
        <CardHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Sparkles className="size-4" />
          </div>
          <CardTitle>Review my training</CardTitle>
          <CardDescription>
            Re-read the last 12 weeks, surface useful patterns, and check for
            new rule-based plan suggestions.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button
            className="h-10 w-full"
            onClick={runReview}
            disabled={!aiAvailable || pending}
          >
            {pending && pendingAction === "review" ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {pending && pendingAction === "review"
              ? "Reviewing your training…"
              : "Create a fresh review"}
          </Button>
          {!hasTrainingData && (
            <p className="text-xs text-muted-foreground">
              You can run this now, but Coach will have more to say after a few
              completed workouts.
            </p>
          )}
          {!aiAvailable && (
            <p className="text-xs text-muted-foreground">
              AI coaching is not configured. Workout tracking and automatic
              rule-based progression suggestions still work.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-xl bg-chart-2/15 text-chart-2">
            <Bot className="size-4" />
          </div>
          <CardTitle>Ask Coach</CardTitle>
          <CardDescription>
            Ask about your own logged sessions. Answers show the evidence used
            and call out missing data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={submitQuestion}>
            <Textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="For example: Am I ready to add weight to my bench press?"
              className="min-h-24 resize-y"
              maxLength={600}
              disabled={!aiAvailable || pending}
              aria-label="Question for Coach"
            />
            <div className="flex flex-wrap gap-1.5">
              {STARTER_QUESTIONS.map((starter) => (
                <Button
                  key={starter}
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setQuestion(starter)}
                  disabled={!aiAvailable || pending}
                  className="h-auto min-h-7 whitespace-normal py-1 text-left"
                >
                  {starter}
                </Button>
              ))}
            </div>
            <Button
              type="submit"
              className="h-10 self-stretch sm:self-end"
              disabled={!aiAvailable || pending || question.trim().length < 3}
            >
              {pending && pendingAction === "ask" ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {pending && pendingAction === "ask" ? "Thinking…" : "Ask Coach"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {(error || message) && (
        <div className="lg:col-span-2" aria-live="polite">
          {error ? (
            <p
              className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : (
            <p className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
              {message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
