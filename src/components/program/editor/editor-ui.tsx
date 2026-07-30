"use client";

import { Check, CircleAlert, Cloud, CloudOff, LoaderCircle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ProgramEditorSaveStatus } from "@/components/program/editor/editor-store";

export function Status({
  status,
  message,
}: {
  status: ProgramEditorSaveStatus;
  message: string | null;
}) {
  const icon =
    status === "saving" || status === "loading" ? (
      <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
    ) : status === "queued" ? (
      <CloudOff className="size-4" />
    ) : status === "saved" ? (
      <Check className="size-4" />
    ) : status === "local" ? (
      <Save className="size-4" />
    ) : status === "conflict" ||
      status === "attention" ||
      status === "failed" ? (
      <CircleAlert className="size-4" />
    ) : (
      <Cloud className="size-4" />
    );
  const label = {
    loading: "Loading draft…",
    saved: "All changes saved",
    local: "Saved on this device",
    saving: "Saving…",
    queued: "Offline — changes queued",
    conflict: "Another tab has newer changes",
    attention: "Finish required fields to save",
    failed: "Save needs attention",
    published: "All changes saved",
  }[status];
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        status === "conflict" || status === "attention" || status === "failed"
          ? "border-destructive/40 text-destructive"
          : "text-muted-foreground",
      )}
    >
      {icon}
      <span>{message ?? label}</span>
    </div>
  );
}

export function Field({
  id,
  label,
  children,
  hint,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && (
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
            )}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
