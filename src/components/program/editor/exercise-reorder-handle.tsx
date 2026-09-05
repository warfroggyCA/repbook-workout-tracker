"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ExerciseReorderHandle({
  dayLineageId,
  descriptionId,
  exerciseName,
  reorderUnitId,
  canMoveUp,
  canMoveDown,
  onMove,
  onPlace,
  onPreview,
  onAnnounce,
  onDragStart,
  onDragEnd,
}: {
  dayLineageId: string;
  descriptionId: string;
  exerciseName: string;
  reorderUnitId: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onPlace: (targetId: string, placement: "before" | "after") => void;
  onPreview: (target: { targetId: string; placement: "before" | "after" } | null) => void;
  onAnnounce: (message: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const dropTarget = useRef<{ targetId: string; placement: "before" | "after" } | null>(null);

  function move(direction: -1 | 1) {
    if ((direction === -1 && !canMoveUp) || (direction === 1 && !canMoveDown)) {
      return;
    }
    onMove(direction);
    onAnnounce(
      `${exerciseName} moved ${direction === -1 ? "up" : "down"}.`,
    );
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const target = dropTarget.current;
    dropTarget.current = null;
    if (event.type === "pointerup" && target) onPlace(target.targetId, target.placement);
    onPreview(null);
    setDragging(false);
    onDragEnd();
    onAnnounce(`${exerciseName} ${event.type === "pointerup" && target ? "placed" : "move cancelled"}.`);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (
      !draggingRef.current ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return;
    }

    const target = event.currentTarget.ownerDocument
      .elementsFromPoint(event.clientX, event.clientY)
      .map((element) =>
        element.closest<HTMLElement>("[data-program-slot-index]"),
      )
      .find(
        (element) =>
          element?.dataset.programDayLineage === dayLineageId,
      );
    const targetId = target?.dataset.programSlotLineage;
    if (!target || !targetId || target.dataset.programSlotUnit === reorderUnitId) {
      dropTarget.current = null;
      onPreview(null);
      return;
    }
    const rect = target.getBoundingClientRect();
    const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    dropTarget.current = { targetId, placement };
    onPreview(dropTarget.current);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    move(event.key === "ArrowUp" ? -1 : 1);
  }

  return (
    <Button
      type="button"
      size="icon-touch"
      variant="outline"
      className={cn(
        "relative z-10 shrink-0 touch-none cursor-grab transition-[transform,background-color,border-color,box-shadow] active:cursor-grabbing motion-reduce:transition-none",
        dragging &&
          "scale-105 cursor-grabbing border-primary bg-primary text-primary-foreground shadow-lg ring-4 ring-primary/30",
      )}
      aria-label={
        dragging
          ? `Moving ${exerciseName}. Release to place.`
          : `Drag ${exerciseName} to reorder`
      }
      aria-describedby={descriptionId}
      aria-keyshortcuts="ArrowUp ArrowDown"
      data-program-reorder-active={dragging ? "true" : undefined}
      title="Drag to reorder. With a keyboard, use the up and down arrow keys."
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        dropTarget.current = null;
        event.currentTarget.setPointerCapture(event.pointerId);
        draggingRef.current = true;
        setDragging(true);
        onDragStart();
        onAnnounce(
          `${exerciseName} picked up. Drag to a new position, then release.`,
        );
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
    >
      <GripVertical aria-hidden="true" />
    </Button>
  );
}
