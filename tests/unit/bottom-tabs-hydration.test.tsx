import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BottomTabs,
  mobileNavigationUsesFocusedWorkoutMode,
  navigationItemIsActive,
  navigationItemShouldPrefetch,
} from "@/components/nav/bottom-tabs";

vi.mock("next/navigation", () => ({
  usePathname: () => "/today",
}));

describe("BottomTabs hydration", () => {
  it("renders a stable inactive server fallback even when the browser pathname is already active", () => {
    const html = renderToStaticMarkup(
      <BottomTabs
        userName="Demo Owner"
        userEmail="owner@example.com"
        collapsed={false}
        onCollapseToggle={() => undefined}
      />,
    );

    expect(html).not.toContain('aria-current="page"');
    expect(html).not.toContain("absolute top-0 h-0.5 w-8");
  });

  it("preserves exact and nested active navigation behavior after hydration", () => {
    expect(navigationItemIsActive("/today", "/today")).toBe(true);
    expect(navigationItemIsActive("/history/session-id", "/history")).toBe(true);
    expect(navigationItemIsActive("/programming", "/program")).toBe(false);
    expect(navigationItemIsActive(null, "/today")).toBe(false);
  });

  it("prefetches destinations but not the exact page already open", () => {
    expect(navigationItemShouldPrefetch("/coach", "/coach")).toBe(false);
    expect(
      navigationItemShouldPrefetch("/history/session-id", "/history"),
    ).toBe(true);
    expect(navigationItemShouldPrefetch(null, "/today")).toBe(true);
  });

  it("reserves extreme-width focused mode for an active workout route", () => {
    expect(mobileNavigationUsesFocusedWorkoutMode("/session/session-id")).toBe(true);
    expect(mobileNavigationUsesFocusedWorkoutMode("/session")).toBe(true);
    expect(mobileNavigationUsesFocusedWorkoutMode("/sessions")).toBe(false);
    expect(mobileNavigationUsesFocusedWorkoutMode("/today")).toBe(false);
    expect(mobileNavigationUsesFocusedWorkoutMode(null)).toBe(false);
  });
});
