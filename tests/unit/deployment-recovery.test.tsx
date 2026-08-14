import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { DeploymentUpdateNoticeView } from "@/components/deployment-update-notice";
import {
  DocumentActionTimeoutError,
  deploymentRecoveryRequired,
  documentRecoveryReason,
  reportDocumentActionTimeout,
  reportDeploymentMismatch,
  subscribeToDeploymentRecovery,
  withDocumentActionDeadline,
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

  it("bounds a missing action acknowledgement and requires a new document", async () => {
    const fakeWindow = new EventTarget();
    vi.stubGlobal("window", fakeWindow);
    const changed = vi.fn();
    const unsubscribe = subscribeToDeploymentRecovery(changed);

    await expect(
      withDocumentActionDeadline(new Promise(() => undefined), 5),
    ).rejects.toBeInstanceOf(DocumentActionTimeoutError);
    expect(deploymentRecoveryRequired()).toBe(false);

    reportDocumentActionTimeout();
    expect(deploymentRecoveryRequired()).toBe(true);
    expect(documentRecoveryReason()).toBe("action_timeout");
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();

    vi.stubGlobal("window", new EventTarget());
    expect(deploymentRecoveryRequired()).toBe(false);
    expect(documentRecoveryReason()).toBeNull();
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

  it("truthfully explains timeout recovery without claiming a deployment", () => {
    const html = renderToStaticMarkup(
      <DeploymentUpdateNoticeView
        reason="action_timeout"
        onReload={() => undefined}
      />,
    );
    expect(html).toContain("Repbook did not confirm a save");
    expect(html).toContain("pending workout changes are safe on this device");
    expect(html).toContain("Reload and retry safely");
    expect(html).not.toContain("Repbook was updated");
  });
});
