import Link from "next/link";
import {
  SETUP_REVIEW_SECTIONS,
  reviewSectionIndex,
  type SetupReviewSectionSlug,
} from "@/lib/setup-review";
import { cn } from "@/lib/utils";

/**
 * Frame for one returning-user review section: progress during Review all,
 * plus fixed Exit and summary destinations. Nothing here re-enters
 * first-time onboarding.
 */
export function SetupReviewShell({
  section,
  reviewAll,
  children,
}: {
  section: SetupReviewSectionSlug;
  reviewAll: boolean;
  children: React.ReactNode;
}) {
  const index = reviewSectionIndex(section);
  const title = SETUP_REVIEW_SECTIONS[index].title;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header>
        <p className="text-xs text-muted-foreground">
          Review setup
          {reviewAll
            ? ` · step ${index + 1} of ${SETUP_REVIEW_SECTIONS.length}`
            : ""}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {title}
        </h1>
        {reviewAll && (
          <div className="mt-2 flex gap-1.5" aria-hidden="true">
            {SETUP_REVIEW_SECTIONS.map((step, stepIndex) => (
              <span
                key={step.slug}
                className={cn(
                  "block h-1.5 flex-1 rounded-full",
                  stepIndex === index
                    ? "bg-primary"
                    : stepIndex < index
                      ? "bg-primary/40"
                      : "bg-muted"
                )}
              />
            ))}
          </div>
        )}
        <nav className="mt-2 flex gap-3 text-xs" aria-label="Review navigation">
          <Link href="/settings/setup" className="inline-flex min-h-11 items-center text-primary underline">
            Back to summary
          </Link>
          <Link href="/settings" className="inline-flex min-h-11 items-center text-primary underline">
            Exit review
          </Link>
        </nav>
      </header>
      <div className="[&_button]:min-h-11 [&_button]:min-w-11">{children}</div>
    </main>
  );
}
