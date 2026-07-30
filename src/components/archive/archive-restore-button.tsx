"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { restoreArchiveOperation } from "@/app/actions/archive";
import { Button } from "@/components/ui/button";

export function ArchiveRestoreButton({ operationId }: { operationId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await restoreArchiveOperation(operationId);
          if (!result.ok) {
            toast.error(result.reason);
            return;
          }
          toast.success("Record restored", {
            description: "It is back in its original date and context.",
          });
          router.refresh();
        })
      }
    >
      <RotateCcw className={pending ? "size-4 animate-spin" : "size-4"} />
      {pending ? "Restoring…" : "Restore"}
    </Button>
  );
}
