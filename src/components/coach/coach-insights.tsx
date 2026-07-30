import { AlertTriangle, CheckCircle2, CircleDot, Database } from "lucide-react";
import type { CoachingReview } from "@/ai/tasks/coaching-review/schema";
import type { CoachingAnswer } from "@/ai/tasks/coaching-qa/schema";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatRelativeDay } from "@/lib/dates";

const toneStyles = {
  positive: "border-success/25 bg-success/5",
  neutral: "border-border/70 bg-muted/30",
  watch: "border-chart-3/35 bg-chart-3/10",
} as const;

function ToneIcon({ tone }: { tone: keyof typeof toneStyles }) {
  if (tone === "positive") return <CheckCircle2 className="size-4 text-success" />;
  if (tone === "watch") return <AlertTriangle className="size-4 text-chart-3" />;
  return <CircleDot className="size-4 text-muted-foreground" />;
}

export function CoachReview({
  review,
  createdAt,
  timezone,
}: {
  review: CoachingReview;
  createdAt: Date;
  timezone: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Latest training review</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">12 weeks</Badge>
            <span className="text-xs text-muted-foreground">
              {formatRelativeDay(createdAt, timezone)}
            </span>
          </div>
        </div>
        <CardDescription className="max-w-3xl text-pretty text-foreground/80">
          {review.summary}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          {review.highlights.map((highlight, index) => (
            <article
              key={`${highlight.title}-${index}`}
              className={cn("rounded-xl border p-3", toneStyles[highlight.tone])}
            >
              <div className="mb-1 flex items-start gap-2">
                <ToneIcon tone={highlight.tone} />
                <h3 className="font-medium leading-snug">{highlight.title}</h3>
              </div>
              <p className="text-sm text-muted-foreground">{highlight.detail}</p>
              {highlight.evidence.length > 0 && (
                <ul className="mt-2 space-y-1 border-t border-current/10 pt-2 text-xs text-muted-foreground">
                  {highlight.evidence.map((item, itemIndex) => (
                    <li key={`${item}-${itemIndex}`}>• {item}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">Focus next</h3>
            <ol className="space-y-2 text-sm text-muted-foreground">
              {review.nextFocus.map((item, index) => (
                <li key={`${item}-${index}`} className="flex gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                    {index + 1}
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <Database className="size-3.5" /> Evidence limits
            </h3>
            {review.dataGaps.length > 0 ? (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {review.dataGaps.map((gap, index) => (
                  <li key={`${gap}-${index}`}>• {gap}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No material data gaps were identified for this review.
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CoachAnswerCard({
  answer,
  question,
  createdAt,
  timezone,
}: {
  answer: CoachingAnswer;
  question: string;
  createdAt: Date;
  timezone: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-primary">
              You asked
            </p>
            <CardTitle>{question}</CardTitle>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeDay(createdAt, timezone)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{answer.answer}</p>
        {answer.evidence.length > 0 && (
          <div className="rounded-xl bg-muted/50 p-3">
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Evidence used
            </h4>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {answer.evidence.map((item, index) => (
                <li key={`${item}-${index}`}>• {item}</li>
              ))}
            </ul>
          </div>
        )}
        {answer.dataGaps.length > 0 && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">What is missing: </span>
            {answer.dataGaps.join(" ")}
          </p>
        )}
        {answer.safetyNote && (
          <p className="rounded-xl bg-chart-3/10 px-3 py-2 text-xs text-foreground">
            <span className="font-medium">Safety note: </span>
            {answer.safetyNote}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
