import type { CoachingReview } from "@/ai/tasks/coaching-review/schema";
import type { CoachingAnswer } from "@/ai/tasks/coaching-qa/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelativeDay } from "@/lib/dates";

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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Written {formatRelativeDay(createdAt, timezone)}
      </p>
      <p className="max-w-3xl text-base leading-relaxed">{review.summary}</p>
      <div className="divide-y">
        {review.highlights.slice(0, 3).map((highlight, index) => (
          <article key={index} className="py-3">
            <h3 className="font-semibold">{highlight.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {highlight.detail}
            </p>
            {highlight.evidence.length > 0 && (
              <details className="mt-2">
                <summary className="min-h-11 cursor-pointer py-2 text-sm text-primary">
                  See supporting details
                </summary>
                <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                  {highlight.evidence.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
      </div>
      <details className="border-t pt-2">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-primary">
          More detail and next steps
        </summary>
        {review.highlights.slice(3).map((highlight, index) => (
          <div key={index} className="py-3">
            <h3 className="font-medium">{highlight.title}</h3>
            <p>{highlight.detail}</p>
            <ul>
              {highlight.evidence.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
        <h3 className="mt-3 font-medium">What to consider next</h3>
        <ul className="mt-2 list-inside list-disc space-y-2 text-sm">
          {review.nextFocus.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
        {review.dataGaps.length > 0 && (
          <>
            <h3 className="mt-4 font-medium">What Coach could not assess</h3>
            <ul className="mt-2 list-inside list-disc space-y-2 text-sm text-muted-foreground">
              {review.dataGaps.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
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
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {answer.answer}
        </p>
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
            <span className="font-medium text-foreground">
              What is missing:{" "}
            </span>
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
