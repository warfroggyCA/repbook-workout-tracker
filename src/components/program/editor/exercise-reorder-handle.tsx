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
  slotIndex,
  canMoveUp,
  canMoveDown,
  onMove,
  onAnnounce,
}: {
  dayLineageId: string;
  descriptionId: string;
  exerciseName: string;
  reorderUnitId: string;
  slotIndex: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onAnnounce: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const lastTargetIndex = useRef<number | null>(null);

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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    lastTargetIndex.current = null;
    draggingRef.current = false;
    setDragging(false);
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
    const targetIndex = Number(target?.dataset.programSlotIndex);
    if (
      !Number.isInteger(targetIndex) ||
      target?.dataset.programSlotUnit === reorderUnitId ||
      targetIndex === slotIndex ||
      targetIndex === lastTargetIndex.current
    ) {
      return;
    }

    lastTargetIndex.current = targetIndex;
    move(targetIndex < slotIndex ? -1 : 1);
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
        "shrink-0 touch-none cursor-grab active:cursor-grabbing",
        dragging && "border-primary bg-primary/10 text-primary ring-2 ring-primary/30",
      )}
      aria-label={`Drag ${exerciseName} to reorder`}
      aria-describedby={descriptionId}
      aria-keyshortcuts="ArrowUp ArrowDown"
      title="Drag to reorder. With a keyboard, use the up and down arrow keys."
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        lastTargetIndex.current = null;
        event.currentTarget.setPointerCapture(event.pointerId);
        draggingRef.current = true;
        setDragging(true);
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
