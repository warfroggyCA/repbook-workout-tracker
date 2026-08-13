"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  deploymentRecoveryRequired,
  getDeploymentRecoveryServerSnapshot,
  subscribeToDeploymentRecovery,
} from "@/lib/deployment-recovery";

export function DeploymentUpdateNoticeView({
  onReload,
}: {
  onReload: () => void;
}) {
  const noticeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    noticeRef.current?.scrollIntoView({ block: "start" });
    noticeRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      ref={noticeRef}
      role="alert"
      aria-labelledby="repbook-update-title"
      tabIndex={-1}
      className="mx-4 mt-3 scroll-mt-3 rounded-2xl border border-amber-400/60 bg-amber-50 p-4 text-amber-950 shadow-sm outline-none dark:border-amber-400/40 dark:bg-amber-950/40 dark:text-amber-100 sm:mx-6 lg:mx-8"
    >
      <div className="flex items-start gap-3">
        <RefreshCw className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="repbook-update-title" className="font-semibold">
            Repbook was updated
          </h2>
          <p className="mt-1 text-sm leading-relaxed">
            Your pending workout changes are safe on this device. Reload once
            to connect to the new version; saving will resume automatically.
          </p>
          <Button
            type="button"
            size="touch"
            variant="outline"
            className="mt-3 w-full border-amber-500/60 bg-background text-foreground sm:w-auto"
            onClick={onReload}
          >
            Reload Repbook
          </Button>
        </div>
      </div>
    </section>
  );
}

export function DeploymentUpdateNotice() {
  const recoveryRequired = useSyncExternalStore(
    subscribeToDeploymentRecovery,
    deploymentRecoveryRequired,
    getDeploymentRecoveryServerSnapshot,
  );

  return recoveryRequired ? (
    <DeploymentUpdateNoticeView onReload={() => window.location.reload()} />
  ) : null;
}
