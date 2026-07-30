import { describe, expect, it } from "vitest";
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_DESCRIPTOR,
  PRODUCT_NAME,
  PRODUCT_NAVIGATION,
  PRODUCT_PROMISE,
  PRODUCT_SHORT_NAME,
  PRODUCT_TENETS,
} from "@/lib/product-identity";

describe("product identity", () => {
  it("keeps one calm, specific shell vocabulary", () => {
    expect({
      name: PRODUCT_NAME,
      shortName: PRODUCT_SHORT_NAME,
      descriptor: PRODUCT_DESCRIPTOR,
      promise: PRODUCT_PROMISE,
      tenets: PRODUCT_TENETS,
    }).toEqual({
      name: "Continuity",
      shortName: "Continuity",
      descriptor: "Private training record",
      promise: "Plan. Train. Review.",
      tenets: "Intent · evidence · continuity",
    });
    expect(PRODUCT_NAVIGATION.map(({ label }) => label)).toEqual([
      "Today",
      "History",
      "Review",
      "Program",
      "Settings",
    ]);
    expect(PRODUCT_NAVIGATION.map(({ purpose }) => purpose)).toEqual([
      "Current work",
      "Recorded evidence",
      "Reviewed change",
      "Program intent",
      "Preferences & safeguards",
    ]);
  });

  it("does not promise unsupported personalization, prediction, or causality", () => {
    const language = [
      PRODUCT_DESCRIPTION,
      PRODUCT_DESCRIPTOR,
      PRODUCT_PROMISE,
      PRODUCT_TENETS,
      ...PRODUCT_NAVIGATION.flatMap(({ label, purpose }) => [label, purpose]),
    ].join(" ");

    expect(language).not.toMatch(
      /personalized|predict(?:s|ed|ion)?|readiness|optimal|learns from you|caused by|pain[- ]free/i
    );
  });
});
