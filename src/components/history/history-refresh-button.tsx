"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HistoryRefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
      {pending ? "Refreshing…" : "Refresh history"}
    </Button>
  );
}
