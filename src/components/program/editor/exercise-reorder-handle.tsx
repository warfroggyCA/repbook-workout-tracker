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
  onDragStart,
  onDragEnd,
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
  onDragStart: () => void;
  onDragEnd: () => void;
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
    if (!draggingRef.current) return;
    draggingRef.current = false;
    lastTargetIndex.current = null;
    setDragging(false);
    onDragEnd();
    onAnnounce(`${exerciseName} placed.`);
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
        lastTargetIndex.current = null;
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
