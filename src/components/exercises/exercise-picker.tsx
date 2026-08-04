"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BODY_AREA_FILTERS,
  DEFAULT_EXERCISE_FILTERS,
  MOVEMENT_FILTERS,
  SHORTCUT_FILTERS,
  activeAdvancedExerciseFilterCount,
  discoverExerciseFamilies,
  visibleEquipmentFilters,
  type BodyAreaFilter,
  type ExerciseDiscoveryFilters,
  type ExerciseDiscoveryItem,
  type MovementFilter,
  type ShortcutFilter,
} from "@/lib/exercise-discovery";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { exercisePickerSelectionState } from "@/lib/exercise-picker";
import { ExerciseReferenceMedia } from "@/components/exercises/exercise-reference-media";
import { ExerciseFamilyIcon } from "@/components/exercises/exercise-family-icon";
import type { ExerciseAlternativeAnnotation } from "@/lib/exercise-alternatives";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Dumbbell,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";

const LABELS: Record<string, string> = {
  current_program: "Current programme",
  recent: "Recently used",
  frequent: "Frequently used",
  hips_glutes: "Hips / glutes",
  horizontal_push: "Horizontal push",
  horizontal_pull: "Horizontal pull",
  vertical_push: "Vertical push",
  vertical_pull: "Vertical pull",
  isolation_arms: "Arm isolation",
  isolation_shoulders: "Shoulder isolation",
  isolation_legs: "Leg isolation",
  weight_reps: "Weight + reps",
  assisted_reps: "Assistance + reps",
  time_reps: "Time + reps",
  per_implement: "Per implement",
  added_weight: "Added weight",
  bodyweight: "Bodyweight",
  bands: "Bands",
  ez_bar: "EZ bar",
  trap_bar: "Trap bar",
  smith_machine: "Smith machine",
  pullup_bar: "Pull-up bar",
};

function label(value: string) {
  return LABELS[value] ?? value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function toggleValue<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function FilterChip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      aria-pressed={active}
      className="min-h-9 whitespace-normal px-3 py-1 text-left"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

function ExerciseVariantButton({
  item,
  selectedId,
  allowed,
  allowUnavailableSelection,
  disabledReason,
  annotation,
  registerButton,
  onInspect,
}: {
  item: ExerciseDiscoveryItem;
  selectedId: string | null;
  allowed: Set<string> | null;
  allowUnavailableSelection: boolean;
  disabledReason?: string;
  annotation?: ExerciseAlternativeAnnotation;
  registerButton: (id: string, node: HTMLButtonElement | null) => void;
  onInspect: (item: ExerciseDiscoveryItem) => void;
}) {
  const permitted = !allowed || allowed.has(item.id);
  const selection = exercisePickerSelectionState({
    available: allowUnavailableSelection || item.available,
    permitted,
    unavailableReason: item.unavailableReason,
    disabledReason,
  });
  const disabled = !selection.selectable;

  return (
    <button
      ref={(node) => registerButton(item.id, node)}
      type="button"
      aria-label={`View details for ${item.name}`}
      className={cn(
        "flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left",
        disabled
          ? "bg-muted/20 text-muted-foreground opacity-65 hover:bg-muted/40"
          : "hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50",
        selectedId === item.id && "bg-primary/10"
      )}
      onClick={() => onInspect(item)}
    >
      <ExerciseFamilyIcon
        media={item.media}
        family={item.family}
        exerciseName={item.name}
        movementPattern={item.movementPattern}
      />
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-foreground">
          {item.name}
        </span>
        <span className="block text-xs">
          {item.equipment.map(label).join(" · ") || "No equipment"}
          {item.primaryMuscles.length > 0
            ? ` · ${item.primaryMuscles.map(label).join(", ")}`
            : ""}
        </span>
        {annotation && (
          <span className="mt-0.5 block text-xs font-medium text-primary">
            {annotation.label}
          </span>
        )}
      </span>
      {disabled ? (
        <span className="max-w-32 shrink-0 text-right text-xs">
          {selection.reason}
        </span>
      ) : selectedId === item.id ? (
        <Badge>Selected</Badge>
      ) : (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function ExerciseDetail({
  item,
  available,
  permitted,
  unavailableReason,
  confirmLabel,
  annotation,
  warning,
  onBack,
  onConfirm,
}: {
  item: ExerciseDiscoveryItem;
  available: boolean;
  permitted: boolean;
  unavailableReason: string | null;
  confirmLabel: string;
  annotation?: ExerciseAlternativeAnnotation;
  warning?: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const attributes = Object.entries(item.variantAttributes)
    .filter(([, value]) => value != null && value !== false && value !== "none")
    .map(([key, value]) => ({ key, value: String(value) }));
  const canAdd = exercisePickerSelectionState({
    available,
    permitted,
    unavailableReason,
  }).selectable;

  useEffect(() => {
    titleRef.current?.focus();
  }, [item.id]);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col">
      <div className="mb-3">
        <Button type="button" variant="ghost" className="-ml-2" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back to results
        </Button>
      </div>

      <article className="space-y-5 pb-4">
        <header>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{item.family ?? "Custom exercise"}</Badge>
            <Badge variant="outline">{label(item.movementPattern)}</Badge>
            {item.inCurrentProgram && <Badge>Current programme</Badge>}
            {item.recentRank != null && <Badge variant="secondary">Recently used</Badge>}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <ExerciseFamilyIcon
              family={item.family}
              exerciseName={item.name}
              movementPattern={item.movementPattern}
              media={item.media}
            />
            <h3
              ref={titleRef}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
            >
              {item.name}
            </h3>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            An exact {label(item.movementPattern).toLowerCase()} variant in the{" "}
            {item.family ?? item.name} family, primarily training{" "}
            {item.primaryMuscles.map(label).join(", ") || "the whole body"}.
          </p>
        </header>

        <section aria-labelledby={`media-${item.id}`}>
          <h4 id={`media-${item.id}`} className="mb-2 font-semibold">
            Reference media
          </h4>
          <ExerciseReferenceMedia
            key={item.id}
            media={item.media}
            exerciseName={item.name}
          />
        </section>

        {annotation && (
          <section className="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <h4 className="font-semibold">{annotation.label}</h4>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {annotation.description}
            </p>
          </section>
        )}

        <section aria-labelledby={`details-${item.id}`}>
          <h4 id={`details-${item.id}`} className="mb-3 font-semibold">
            Exercise details
          </h4>
          <dl className="grid gap-3 rounded-2xl border bg-card p-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Equipment
              </dt>
              <dd className="mt-1 font-medium">
                {item.equipment.map(label).join(", ") || "No equipment"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Primary muscles
              </dt>
              <dd className="mt-1 font-medium">
                {item.primaryMuscles.map(label).join(", ") || "Full body"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Supporting muscles
              </dt>
              <dd className="mt-1 font-medium">
                {item.secondaryMuscles.map(label).join(", ") || "None listed"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Tracked as
              </dt>
              <dd className="mt-1 font-medium">{label(item.metricType)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Load style
              </dt>
              <dd className="mt-1 font-medium">{label(item.loadType)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Weight entry
              </dt>
              <dd className="mt-1 font-medium">{label(item.loadSemantics)}</dd>
            </div>
          </dl>
          {attributes.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {attributes.map((attribute) => (
                <Badge key={attribute.key} variant="outline">
                  {label(attribute.key)}: {label(attribute.value)}
                </Badge>
              ))}
            </div>
          )}
        </section>

        {item.cautionBodyParts.length > 0 && (
          <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <p>Use caution for your {item.cautionBodyParts.map(label).join(", ")} constraint.</p>
          </div>
        )}

        {warning && (
          <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">Required equipment is unavailable</p>
              <p className="mt-0.5">{warning}</p>
            </div>
          </div>
        )}

        {!canAdd && (
          <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">This variant cannot be selected here.</p>
              <p className="mt-0.5">
                {unavailableReason ?? "It is not a compatible choice for this context."}
              </p>
            </div>
          </div>
        )}
      </article>

      <footer className="sticky bottom-0 mt-auto flex flex-col-reverse gap-2 border-t bg-popover/95 py-3 backdrop-blur sm:flex-row sm:justify-between">
        <Button type="button" variant="outline" className="min-h-10" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Button type="button" className="min-h-10" disabled={!canAdd} onClick={onConfirm}>
          <Check className="size-4" /> {confirmLabel}
        </Button>
      </footer>
    </div>
  );
}

export function ExercisePicker({
  items,
  onSelect,
  triggerLabel = "Browse exercise library",
  title = "Choose an exercise",
  description = "Browse by family, then choose the exact equipment or technique variant.",
  selectedId = null,
  confirmLabel = "Add exercise",
  allowedIds,
  disabledReasons = {},
  priorityIds = [],
  itemAnnotations = {},
  itemWarnings = {},
  largeTouchTargets = false,
  allowUnavailableSelection = false,
  initialAvailability = "available",
  defaultOpen = false,
  onOpenChange,
}: {
  items: ExerciseDiscoveryItem[];
  onSelect: (
    item: ExerciseDiscoveryItem,
  ) => boolean | void | Promise<boolean | void>;
  triggerLabel?: string;
  title?: string;
  description?: string;
  selectedId?: string | null;
  confirmLabel?: string;
  allowedIds?: string[];
  disabledReasons?: Record<string, string>;
  priorityIds?: string[];
  itemAnnotations?: Record<string, ExerciseAlternativeAnnotation>;
  itemWarnings?: Record<string, string>;
  largeTouchTargets?: boolean;
  allowUnavailableSelection?: boolean;
  initialAvailability?: "available" | "all";
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<ExerciseDiscoveryFilters>({
    ...DEFAULT_EXERCISE_FILTERS,
    availability: initialAvailability,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleFamilyCount, setVisibleFamilyCount] = useState(30);
  const [inspected, setInspected] = useState<ExerciseDiscoveryItem | null>(null);
  const [selecting, setSelecting] = useState(false);
  const selectingRef = useRef(false);
  const [visualViewport, setVisualViewport] = useState<{
    height: number;
    offsetTop: number;
  } | null>(null);
  const resultsScrollRef = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const variantButtons = useRef(new Map<string, HTMLButtonElement>());
  const allowed = useMemo(() => (allowedIds ? new Set(allowedIds) : null), [allowedIds]);
  const families = useMemo(() => {
    const discovered = discoverExerciseFamilies(items, filters);
    if (filters.query.trim() || priorityIds.length === 0) return discovered;
    const priority = new Map(priorityIds.map((id, index) => [id, index]));
    const fallback = Number.MAX_SAFE_INTEGER;
    return discovered
      .map((family) => ({
        ...family,
        variants: [...family.variants].sort(
          (a, b) =>
            (priority.get(a.id) ?? fallback) - (priority.get(b.id) ?? fallback) ||
            a.name.localeCompare(b.name)
        ),
      }))
      .sort((a, b) => {
        const aPriority = Math.min(
          ...a.variants.map((item) => priority.get(item.id) ?? fallback)
        );
        const bPriority = Math.min(
          ...b.variants.map((item) => priority.get(item.id) ?? fallback)
        );
        return aPriority - bPriority || a.name.localeCompare(b.name);
      });
  }, [filters, items, priorityIds]);
  const equipmentFilters = useMemo(() => visibleEquipmentFilters(items), [items]);
  const activeCount = activeAdvancedExerciseFilterCount(filters);
  const hasResettableFilters =
    activeCount > 0 ||
    filters.shortcuts.length > 0 ||
    filters.availability !== DEFAULT_EXERCISE_FILTERS.availability ||
    filters.query.length > 0;
  const searching = filters.query.trim().length > 0;
  const shownFamilies = families.slice(0, visibleFamilyCount);
  const resultCount = families.reduce((count, family) => count + family.variants.length, 0);
  const hasShortcut = (shortcut: ShortcutFilter) =>
    items.some((item) =>
      shortcut === "current_program"
        ? item.inCurrentProgram
        : shortcut === "recent"
          ? item.recentRank != null
          : item.frequentlyUsed
    );

  function clearFilters() {
    setFilters({ ...DEFAULT_EXERCISE_FILTERS });
    setVisibleFamilyCount(30);
  }

  async function confirmPick(item: ExerciseDiscoveryItem) {
    if (
      selectingRef.current ||
      (!allowUnavailableSelection && !item.available) ||
      (allowed && !allowed.has(item.id))
    ) return;
    selectingRef.current = true;
    setSelecting(true);
    try {
      const result = await onSelect(item);
      if (result === false) return;
      setOpen(false);
      setInspected(null);
    } finally {
      selectingRef.current = false;
      setSelecting(false);
    }
  }

  function inspect(item: ExerciseDiscoveryItem) {
    savedScrollTop.current = resultsScrollRef.current?.scrollTop ?? 0;
    setInspected(item);
    requestAnimationFrame(() => resultsScrollRef.current?.scrollTo({ top: 0 }));
  }

  function returnToResults() {
    const inspectedId = inspected?.id;
    setInspected(null);
    requestAnimationFrame(() => {
      resultsScrollRef.current?.scrollTo({ top: savedScrollTop.current });
      if (inspectedId) variantButtons.current.get(inspectedId)?.focus();
    });
  }

  function registerVariantButton(
    id: string,
    node: HTMLButtonElement | null,
  ) {
    if (node) variantButtons.current.set(id, node);
    else variantButtons.current.delete(id);
  }

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const viewport = window.visualViewport;
      setVisualViewport({
        height: viewport?.height ?? window.innerHeight,
        offsetTop: viewport?.offsetTop ?? 0,
      });
    };
    const frame = requestAnimationFrame(update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !visualViewport) return;
    const scrollRegion = resultsScrollRef.current;
    if (!scrollRegion) return;
    let frame = 0;
    const keepActiveControlVisible = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !scrollRegion.contains(active)) {
        return;
      }
      const regionRect = scrollRegion.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const inset = 8;
      if (activeRect.bottom > regionRect.bottom - inset) {
        scrollRegion.scrollTop += activeRect.bottom - regionRect.bottom + inset;
      } else if (activeRect.top < regionRect.top + inset) {
        scrollRegion.scrollTop -= regionRect.top - activeRect.top + inset;
      }
    };
    const scheduleVisibilityCheck = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(keepActiveControlVisible);
    };
    const scrollRegionObserver = new ResizeObserver(scheduleVisibilityCheck);
    scrollRegionObserver.observe(scrollRegion);
    scheduleVisibilityCheck();
    return () => {
      cancelAnimationFrame(frame);
      scrollRegionObserver.disconnect();
    };
  }, [open, visualViewport]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setInspected(null);
        onOpenChange?.(nextOpen);
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className={cn(
              "h-auto min-h-10 w-full min-w-0 justify-start whitespace-normal py-2 text-left leading-tight",
              largeTouchTargets && "min-h-11",
            )}
          />
        }
      >
        <Dumbbell className="size-4" />
        <span className="min-w-0 whitespace-normal break-words text-left">
          {triggerLabel}
        </span>
      </DialogTrigger>
      <DialogContent className={cn(
        "flex max-w-[calc(100%-1rem)] grid-rows-none flex-col gap-3 overflow-hidden p-0 sm:max-w-4xl",
        largeTouchTargets && "[&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11"
      )}
      style={
        visualViewport
          ? {
              top: visualViewport.offsetTop + visualViewport.height / 2,
              height: Math.max(
                1,
                Math.min(visualViewport.height - 16, 896),
              ),
              maxHeight: Math.max(1, visualViewport.height - 16),
            }
          : { height: "min(90dvh, 56rem)", maxHeight: "calc(100dvh - 1rem)" }
      }>
        <div
          ref={resultsScrollRef}
          data-testid="exercise-picker-scroll"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
        <DialogHeader className="px-4 pt-4 pr-12 sm:px-5 sm:pt-5 sm:pr-12">
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription
            tabIndex={0}
            className="pr-1"
          >
            {description}
          </DialogDescription>
        </DialogHeader>

        {!inspected && (
          <div
            role="region"
            aria-label="Exercise search and filters"
            className="space-y-3 border-b px-4 pb-3 sm:px-5"
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={filters.query}
                onChange={(event) => {
                  setFilters((current) => ({
                    ...current,
                    query: event.target.value,
                  }));
                  setVisibleFamilyCount(30);
                }}
                placeholder="Search exercises, families, muscles, or equipment"
                aria-label="Search exercise library"
                className="h-11 pl-9 pr-10"
              />
              {filters.query && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Clear exercise search"
                  className="absolute right-2 top-2"
                  onClick={() => setFilters((current) => ({ ...current, query: "" }))}
                >
                  <X className="size-4" />
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {(["available", "all"] as const).map((availability) => (
                <FilterChip
                  key={availability}
                  active={filters.availability === availability}
                  onClick={() => setFilters((current) => ({ ...current, availability }))}
                >
                  {availability === "available" ? "Available to me" : "All exercises"}
                </FilterChip>
              ))}
              {SHORTCUT_FILTERS.filter(hasShortcut).map((shortcut) => (
                <FilterChip
                  key={shortcut}
                  active={filters.shortcuts.includes(shortcut)}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      shortcuts: toggleValue(current.shortcuts, shortcut),
                    }))
                  }
                >
                  {label(shortcut)}
                </FilterChip>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-expanded={showFilters}
                className="min-h-9"
                onClick={() => setShowFilters((current) => !current)}
              >
                <SlidersHorizontal className="size-4" /> Filters
                {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
              </Button>
              {hasResettableFilters && (
                <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>
                  Clear all
                </Button>
              )}
            </div>

            {showFilters && (
              <div className="grid gap-4 rounded-xl border bg-muted/20 p-3 sm:grid-cols-2">
                <FilterGroup title="Equipment">
                  {equipmentFilters.map((equipment) => (
                    <FilterChip
                      key={equipment}
                      active={filters.equipment.includes(equipment)}
                      onClick={() =>
                        setFilters((current) => ({
                          ...current,
                          equipment: toggleValue(current.equipment, equipment),
                        }))
                      }
                    >
                      {label(equipment)}
                    </FilterChip>
                  ))}
                </FilterGroup>
                <FilterGroup title="Body area / primary muscle">
                  {BODY_AREA_FILTERS.map((area) => (
                    <FilterChip
                      key={area}
                      active={filters.bodyAreas.includes(area)}
                      onClick={() =>
                        setFilters((current) => ({
                          ...current,
                          bodyAreas: toggleValue<BodyAreaFilter>(current.bodyAreas, area),
                        }))
                      }
                    >
                      {label(area)}
                    </FilterChip>
                  ))}
                </FilterGroup>
                <FilterGroup title="Movement">
                  {MOVEMENT_FILTERS.map((movement) => (
                    <FilterChip
                      key={movement}
                      active={filters.movements.includes(movement)}
                      onClick={() =>
                        setFilters((current) => ({
                          ...current,
                          movements: toggleValue<MovementFilter>(current.movements, movement),
                        }))
                      }
                    >
                      {label(movement)}
                    </FilterChip>
                  ))}
                </FilterGroup>
              </div>
            )}
          </div>
        )}

        <div className="px-4 pb-5 sm:px-5">
          {inspected ? (
            <ExerciseDetail
              item={inspected}
              available={allowUnavailableSelection || inspected.available}
              permitted={!allowed || allowed.has(inspected.id)}
              unavailableReason={
                !inspected.available && !allowUnavailableSelection
                  ? inspected.unavailableReason
                  : (disabledReasons[inspected.id] ?? null)
              }
              confirmLabel={confirmLabel}
              annotation={itemAnnotations[inspected.id]}
              warning={itemWarnings[inspected.id]}
              onBack={returnToResults}
              onConfirm={() => void confirmPick(inspected)}
            />
          ) : (
            <>
              <p className="sticky top-0 z-10 -mx-1 mb-2 bg-popover/95 px-1 py-2 text-xs text-muted-foreground backdrop-blur">
                {resultCount} variant{resultCount === 1 ? "" : "s"} in {families.length} famil
                {families.length === 1 ? "y" : "ies"}
              </p>
              {shownFamilies.length === 0 ? (
                <div className="rounded-xl border border-dashed p-6 text-center">
                  <p className="font-medium">No exercises match those choices.</p>
                  <Button type="button" variant="link" onClick={clearFilters}>
                    Clear search and filters
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {shownFamilies.map((family) => {
                    const isExpanded = searching || expanded.has(family.key);
                    const availableCount = family.variants.filter(
                      (item) =>
                        (allowUnavailableSelection || item.available) &&
                        (!allowed || allowed.has(item.id))
                    ).length;
                    const onlyVariant = family.variants.length === 1
                      ? family.variants[0]
                      : null;
                    if (onlyVariant) {
                      return (
                        <div
                          key={family.key}
                          className="overflow-hidden rounded-xl border bg-card"
                        >
                          <ExerciseVariantButton
                            item={onlyVariant}
                            selectedId={selectedId}
                            allowed={allowed}
                            allowUnavailableSelection={allowUnavailableSelection}
                            disabledReason={disabledReasons[onlyVariant.id]}
                            annotation={itemAnnotations[onlyVariant.id]}
                            registerButton={registerVariantButton}
                            onInspect={inspect}
                          />
                        </div>
                      );
                    }
                    return (
                      <section
                        key={family.key}
                        className="overflow-hidden rounded-xl border bg-card"
                      >
                        <button
                          type="button"
                          className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(family.key)) next.delete(family.key);
                              else next.add(family.key);
                              return next;
                            })
                          }
                        >
                          {isExpanded ? (
                            <ChevronDown className="size-4 shrink-0" />
                          ) : (
                            <ChevronRight className="size-4 shrink-0" />
                          )}
                          <ExerciseFamilyIcon
                            family={family.name}
                            exerciseName={family.name}
                            movementPattern={
                              family.variants[0]?.movementPattern ?? "conditioning"
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold">{family.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {family.variants.length} variant
                              {family.variants.length === 1 ? "" : "s"}
                              {availableCount < family.variants.length
                                ? ` · ${availableCount} selectable`
                                : ""}
                            </span>
                          </span>
                        </button>
                        {isExpanded && (
                          <div className="divide-y border-t">
                            {family.variants.map((item) => (
                              <ExerciseVariantButton
                                key={item.id}
                                item={item}
                                selectedId={selectedId}
                                allowed={allowed}
                                allowUnavailableSelection={allowUnavailableSelection}
                                disabledReason={disabledReasons[item.id]}
                                annotation={itemAnnotations[item.id]}
                                registerButton={registerVariantButton}
                                onInspect={inspect}
                              />
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
                  {visibleFamilyCount < families.length && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-10 w-full"
                      onClick={() => setVisibleFamilyCount((count) => count + 30)}
                    >
                      Show more families
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        </div>
        {!inspected && (
          <footer className="shrink-0 border-t bg-popover px-4 py-3 sm:px-5">
            <Button
              type="button"
              variant="outline"
              className="min-h-10 w-full sm:w-auto"
              disabled={selecting}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </footer>
        )}
      </DialogContent>
    </Dialog>
  );
}
