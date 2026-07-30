"use client";

import { useTransition } from "react";
import { LoaderCircle, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { runRecoveryChecks } from "@/app/actions/recovery";
import { Button } from "@/components/ui/button";

export function RecoveryCheckButton() {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await runRecoveryChecks();
          if (!result.ok) {
            toast.error("Recovery checks did not finish", {
              description: result.reason,
            });
            return;
          }
          if (result.attentionCount > 0) {
            toast.warning("Recovery checks finished", {
              description: result.message,
            });
          } else {
            toast.success("Recovery checks passed", {
              description: result.message,
            });
          }
        })
      }
    >
      {pending ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <ScanSearch className="size-4" />
      )}
      {pending ? "Checking protected data…" : "Run recovery checks"}
    </Button>
  );
}
