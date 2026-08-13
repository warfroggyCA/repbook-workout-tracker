import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { DeploymentUpdateNoticeView } from "@/components/deployment-update-notice";
import {
  deploymentRecoveryRequired,
  reportDeploymentMismatch,
  subscribeToDeploymentRecovery,
} from "@/lib/deployment-recovery";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("deployment recovery", () => {
  it("configures the Vercel deployment identity for Next.js skew protection", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test_recovery");
    const { default: config } = await import("../../next.config");
    expect(config.deploymentId).toBe("dpl_test_recovery");
  });

  it("classifies only Next.js action-version mismatches and not connection errors", () => {
    const fakeWindow = new EventTarget();
    vi.stubGlobal("window", fakeWindow);
    const changed = vi.fn();
    const unsubscribe = subscribeToDeploymentRecovery(changed);

    expect(reportDeploymentMismatch(new Error("offline"))).toBe(false);
    expect(deploymentRecoveryRequired()).toBe(false);

    const mismatch = new UnrecognizedActionError("old action");
    expect(reportDeploymentMismatch(mismatch)).toBe(true);
    expect(reportDeploymentMismatch(mismatch)).toBe(true);
    expect(deploymentRecoveryRequired()).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("keeps the reload recovery concise, touch-sized, and in page flow", () => {
    const html = renderToStaticMarkup(
      <DeploymentUpdateNoticeView onReload={() => undefined} />,
    );
    expect(html).toContain("Repbook was updated");
    expect(html).toContain("pending workout changes are safe on this device");
    expect(html).toContain("Reload Repbook");
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("scroll-mt-3");
    expect(html).toContain("min-h-11");
    expect(html).not.toMatch(/class="[^"]*\bfixed\b/);
    expect(html).not.toMatch(/class="[^"]*\bsticky\b/);
  });
});
