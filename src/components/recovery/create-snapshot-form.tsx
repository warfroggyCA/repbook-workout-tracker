"use client";

import { useState, useTransition } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { createSnapshotNow } from "@/app/actions/snapshots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function CreateSnapshotForm({ defaultName }: { defaultName: string }) {
  const [name, setName] = useState(defaultName);
  const [note, setNote] = useState("");
  const [pinned, setPinned] = useState(true);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Snapshot name</span>
        <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Note (optional)</span>
        <Textarea
          value={note}
          maxLength={1000}
          placeholder="Known good after reviewed Hevy import."
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={pinned}
          onChange={(event) => setPinned(event.target.checked)}
        />
        Pin this snapshot so automatic retention can never remove it
      </label>
      <Button
        className="w-fit"
        disabled={pending || !name.trim()}
        onClick={() =>
          startTransition(async () => {
            const result = await createSnapshotNow({
              name,
              note: note || null,
              pinned,
            });
            if (!result.ok) {
              toast.error("Snapshot was not created", { description: result.reason });
              return;
            }
            toast.success("Snapshot verified", {
              description: "The encrypted copy was stored outside the database and read back successfully.",
            });
            setName(defaultName);
            setNote("");
          })
        }
      >
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        {pending ? "Creating and verifying…" : "Create snapshot now"}
      </Button>
    </div>
  );
}
