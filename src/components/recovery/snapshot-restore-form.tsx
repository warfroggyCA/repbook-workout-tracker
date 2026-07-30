"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { restoreSnapshot } from "@/app/actions/snapshots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { SnapshotRestoreScope } from "@/services/snapshot-restore";

export function SnapshotRestoreForm({
  snapshotId,
  snapshotName,
  scope,
  previewFingerprint,
  hasChanges,
}: {
  snapshotId: string;
  snapshotName: string;
  scope: SnapshotRestoreScope;
  previewFingerprint: string;
  hasChanges: boolean;
}) {
  const router = useRouter();
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ready = acknowledged && confirmation === "RESTORE" && hasChanges;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-lg border p-3">
        <Checkbox
          id="restore-acknowledgement"
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
        />
        <label htmlFor="restore-acknowledgement" className="text-sm leading-relaxed">
          I reviewed this exact preview. I understand that the listed current records
          will be replaced by the records from “{snapshotName}”.
        </label>
      </div>
      <div className="space-y-2">
        <label htmlFor="restore-confirmation" className="text-sm font-medium">
          Type RESTORE to continue
        </label>
        <Input
          id="restore-confirmation"
          autoComplete="off"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder="RESTORE"
        />
      </div>
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">
        <p className="flex items-center gap-2 font-medium">
          <ShieldCheck className="size-4" /> A verified safety copy is mandatory
        </p>
        <p className="mt-1 leading-relaxed">
          The app creates and verifies a new encrypted copy of your current data first.
          If that fails, or if the restore cannot finish completely, your current data
          is left unchanged.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button
        disabled={!ready || pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await restoreSnapshot({
              snapshotId,
              scope,
              previewFingerprint,
              confirmation,
            });
            if (!result.ok) {
              setError(result.reason);
              return;
            }
            toast.success(scope === "full" ? "Snapshot restored" : "History restored", {
              description: `${result.restoredRecords} records were restored after a new safety copy was verified.`,
            });
            router.push("/recovery");
            router.refresh();
          })
        }
      >
        <RotateCcw className="size-4" />
        {pending ? "Protecting and restoring…" : "Create safety copy and restore"}
      </Button>
      {!hasChanges && (
        <p className="text-sm text-muted-foreground">
          The selected records already match this snapshot, so there is nothing to restore.
        </p>
      )}
    </div>
  );
}
