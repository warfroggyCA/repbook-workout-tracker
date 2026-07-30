export const PRODUCT_NAME = "Repbook";
export const PRODUCT_SHORT_NAME = "Repbook";
export const PRODUCT_FORMAL_NAME = "Repbook Workout Tracker";
export const PRODUCT_DESCRIPTOR = "Private training record";
export const PRODUCT_PROMISE = "Plan. Train. Review.";
export const PRODUCT_TENETS = "Intent · evidence · continuity";
export const PRODUCT_DESCRIPTION =
  "A private training record that keeps Program intent, performed work, recorded evidence, and reviewed change connected.";

export const PRODUCT_NAVIGATION = [
  { href: "/today", label: "Today", purpose: "Current work" },
  { href: "/history", label: "History", purpose: "Recorded evidence" },
  { href: "/coach", label: "Review", purpose: "Reviewed change" },
  { href: "/program", label: "Program", purpose: "Program intent" },
  { href: "/settings", label: "Settings", purpose: "Preferences & safeguards" },
] as const;
