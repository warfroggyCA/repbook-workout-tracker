"use client";

import { unstable_isUnrecognizedActionError } from "next/navigation";

const DEPLOYMENT_RECOVERY_EVENT = "repbook-deployment-recovery";
const affectedWindows = new WeakSet<object>();

function currentWindow() {
  return typeof window === "undefined" ? null : window;
}

export function deploymentRecoveryRequired() {
  const browserWindow = currentWindow();
  return browserWindow != null && affectedWindows.has(browserWindow);
}

export function getDeploymentRecoveryServerSnapshot() {
  return false;
}

export function subscribeToDeploymentRecovery(onStoreChange: () => void) {
  window.addEventListener(DEPLOYMENT_RECOVERY_EVENT, onStoreChange);
  return () => {
    window.removeEventListener(DEPLOYMENT_RECOVERY_EVENT, onStoreChange);
  };
}

export function reportDeploymentMismatch(error: unknown) {
  if (!unstable_isUnrecognizedActionError(error)) return false;

  const browserWindow = currentWindow();
  if (browserWindow == null) return true;
  if (!affectedWindows.has(browserWindow)) {
    affectedWindows.add(browserWindow);
    browserWindow.dispatchEvent(new Event(DEPLOYMENT_RECOVERY_EVENT));
  }
  return true;
}
