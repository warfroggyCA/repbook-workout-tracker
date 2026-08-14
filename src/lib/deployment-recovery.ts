"use client";

import { unstable_isUnrecognizedActionError } from "next/navigation";

const DEPLOYMENT_RECOVERY_EVENT = "repbook-deployment-recovery";
export const DOCUMENT_ACTION_DEADLINE_MS = 15_000;

export type DocumentRecoveryReason = "deployment_update" | "action_timeout";

const affectedWindows = new WeakMap<object, DocumentRecoveryReason>();

export class DocumentActionTimeoutError extends Error {
  constructor() {
    super("The server action did not acknowledge before the document deadline.");
    this.name = "DocumentActionTimeoutError";
  }
}

function currentWindow() {
  return typeof window === "undefined" ? null : window;
}

export function deploymentRecoveryRequired() {
  const browserWindow = currentWindow();
  return browserWindow != null && affectedWindows.has(browserWindow);
}

export function documentRecoveryReason(): DocumentRecoveryReason | null {
  const browserWindow = currentWindow();
  return browserWindow == null
    ? null
    : affectedWindows.get(browserWindow) ?? null;
}

export function getDocumentRecoveryReasonServerSnapshot() {
  return null;
}

export function getDeploymentRecoveryServerSnapshot() {
  return false;
}

export function subscribeToDeploymentRecovery(onStoreChange: () => void) {
  const browserWindow = window;
  browserWindow.addEventListener(DEPLOYMENT_RECOVERY_EVENT, onStoreChange);
  return () => {
    browserWindow.removeEventListener(DEPLOYMENT_RECOVERY_EVENT, onStoreChange);
  };
}

export function reportDeploymentMismatch(error: unknown) {
  if (!unstable_isUnrecognizedActionError(error)) return false;

  const browserWindow = currentWindow();
  if (browserWindow == null) return true;
  if (!affectedWindows.has(browserWindow)) {
    affectedWindows.set(browserWindow, "deployment_update");
    browserWindow.dispatchEvent(new Event(DEPLOYMENT_RECOVERY_EVENT));
  }
  return true;
}

export function reportDocumentActionTimeout() {
  const browserWindow = currentWindow();
  if (browserWindow == null) return;
  if (!affectedWindows.has(browserWindow)) {
    affectedWindows.set(browserWindow, "action_timeout");
    browserWindow.dispatchEvent(new Event(DEPLOYMENT_RECOVERY_EVENT));
  }
}

export function isDocumentActionTimeout(error: unknown) {
  return error instanceof DocumentActionTimeoutError;
}

/**
 * Next.js dispatches Server Actions sequentially in one document. A request
 * that never settles would otherwise hold both that dispatcher and Repbook's
 * device-queue lock forever. The underlying request may still commit after
 * this deadline, so callers must retain the exact durable command and require
 * a new document before replaying its stable identity.
 */
export async function withDocumentActionDeadline<T>(
  action: Promise<T>,
  deadlineMs = DOCUMENT_ACTION_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DocumentActionTimeoutError()),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
