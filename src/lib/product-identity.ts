export const PRODUCT_NAME = "Repbook";
export const PRODUCT_SHORT_NAME = "Repbook";
export const PRODUCT_FORMAL_NAME = "Repbook Workout Tracker";
export const PRODUCT_DESCRIPTOR = "Private training record";
export const PRODUCT_PROMISE = "Plan. Train. Review.";
export const PRODUCT_TENETS = "Plan · train · progress";
export const PRODUCT_DESCRIPTION =
  "Your workouts, plans, and progress in one private place.";

export const PRODUCT_NAVIGATION = [
  { href: "/today", label: "Today", purpose: "Your next workout" },
  { href: "/history", label: "History", purpose: "Your training records" },
  {
    href: "/coach",
    label: "Coach",
    purpose: "Training guidance and proposed changes",
  },
  { href: "/program", label: "Program", purpose: "Your training plan" },
  { href: "/settings", label: "Settings", purpose: "Your preferences" },
] as const;
