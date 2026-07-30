/**
 * Returning-user setup review (UI-007): fixed sections and closed, typed
 * destinations. Pages and forms only ever navigate to values produced here —
 * never to an arbitrary client-supplied return URL.
 */

export const SETUP_REVIEW_SECTIONS = [
  { slug: "profile", title: "Profile" },
  { slug: "equipment", title: "Equipment" },
  { slug: "constraints", title: "Constraints" },
  { slug: "coaching", title: "Coaching preferences" },
  { slug: "program", title: "Current Program" },
] as const;

export type SetupReviewSectionSlug =
  (typeof SETUP_REVIEW_SECTIONS)[number]["slug"];

export function isSetupReviewSection(
  slug: string
): slug is SetupReviewSectionSlug {
  return SETUP_REVIEW_SECTIONS.some((section) => section.slug === slug);
}

export function reviewSectionIndex(slug: SetupReviewSectionSlug): number {
  return SETUP_REVIEW_SECTIONS.findIndex((section) => section.slug === slug);
}

/**
 * Where "continue" goes from a section: the next section during the
 * Review-all walkthrough, otherwise back to the summary hub.
 */
export function nextReviewDestination(
  slug: SetupReviewSectionSlug,
  reviewAll: boolean
): string {
  if (!reviewAll) return "/settings/setup";
  const index = reviewSectionIndex(slug);
  const next = SETUP_REVIEW_SECTIONS[index + 1];
  return next ? `/settings/setup/${next.slug}?flow=all` : "/settings";
}

/** Context handed to the shared setup forms when used for review. */
export type SetupReviewFormContext = {
  mode: "review";
  nextHref: string;
};
