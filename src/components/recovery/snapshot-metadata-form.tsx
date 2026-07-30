"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Download, Pin, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { updateSnapshotMetadata } from "@/app/actions/snapshots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function SnapshotMetadataForm({
  snapshotId,
  initialName,
  initialNote,
  initialPinned,
  canDownload,
}: {
  snapshotId: string;
  initialName: string;
  initialNote: string | null;
  initialPinned: boolean;
  canDownload: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [note, setNote] = useState(initialNote ?? "");
  const [pinned, setPinned] = useState(initialPinned);
  const [pending, startTransition] = useTransition();

  function beginEditing() {
    setName(initialName);
    setNote(initialNote ?? "");
    setPinned(initialPinned);
    setEditing(true);
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={beginEditing}>
          {initialPinned && <Pin className="size-3.5" />} Edit details
        </Button>
        {canDownload && (
          <>
            <Button
              size="sm"
              variant="outline"
              render={<Link href={`/recovery/${snapshotId}/restore`} />}
              nativeButton={false}
            >
              <RotateCcw className="size-3.5" /> Preview restore
            </Button>
            <Button
              size="sm"
              variant="outline"
              render={<a href={`/api/snapshots/${snapshotId}/download`} download />}
              nativeButton={false}
            >
              <Download className="size-3.5" /> Download
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background p-3">
      <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
      <Textarea value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={pinned}
          onChange={(event) => setPinned(event.target.checked)}
        />
        Pinned
      </label>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || !name.trim()}
          onClick={() =>
            startTransition(async () => {
              const result = await updateSnapshotMetadata(snapshotId, {
                name,
                note: note || null,
                pinned,
              });
              if (!result.ok) {
                toast.error(result.reason);
                return;
              }
              toast.success("Snapshot details updated", {
                description: "The protected data, checksums, creation time, and verification are unchanged.",
              });
              setEditing(false);
            })
          }
        >
          {pending ? "Saving…" : "Save details"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
