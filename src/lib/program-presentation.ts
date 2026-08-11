import {
  hasGeneratedOverviewWarmupItems,
  type ProgramDayIntent,
  type ProgramDayWarmupItem,
} from "@/lib/program-document";
import { formatWarmupSetLine, type WarmupSetDisplayInput } from "@/lib/warmup";

export type ProgramPresentationSource = {
  program: { id: string; name: string };
  version: { id: string; versionNo: number };
  days: Array<{
    id: string;
    lineageId: string;
    name: string;
    notes: string | null;
    warmupNotes: string | null;
    warmupItems?: ProgramDayWarmupItem[];
    orderIdx: number;
    // Already present on the loaded template row, so carrying it costs no
    // additional query. Null on days saved before day intent existed.
    intent: ProgramDayIntent | null;
    slots: Array<{
      id: string;
      lineageId: string;
      exercise: {
        id: string;
        name: string;
        family: string | null;
        movementPattern: string;
      };
      orderIdx: number;
      supersetGroupId: string | null;
      restSec: number;
      notes: string | null;
      warmupNotes: string | null;
      warmupSets: WarmupSetDisplayInput[];
      prescription: {
        sets: number;
        repRangeMin: number;
        repRangeMax: number;
        targetLoad: number | null;
        targetLoadUnit: "lb" | "kg" | null;
        progressionRuleId: string;
      } | null;
    }>;
  }>;
  groups: Array<{
    id: string;
    name: string;
    restAfterRoundSec: number;
  }>;
};

export type ProgramPresentation = {
  program: ProgramPresentationSource["program"];
  version: ProgramPresentationSource["version"];
  days: Array<{
    id: string;
    lineageId: string;
    name: string;
    notes: string | null;
    orderIdx: number;
    intent: ProgramDayIntent | null;
    warmupLines: string[];
    slots: Array<ProgramPresentationSource["days"][number]["slots"][number] & {
      superset: {
        id: string;
        name: string;
        restAfterRoundSec: number;
        memberNames: string[];
      } | null;
    }>;
  }>;
};

function normalizedLine(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function addUniqueLine(lines: string[], seen: Set<string>, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return;
  const key = normalizedLine(trimmed);
  if (seen.has(key)) return;
  seen.add(key);
  lines.push(trimmed);
}

export function formatProgramDayLabel(name: string, index: number): string {
  const ordinal = index + 1;
  const base = `Day ${ordinal}`;
  const match = name.match(
    /^\s*day\s+(\d+)(?=$|[\s—–\-.:·])([\s—–\-.:·]*)(.*?)\s*$/i,
  );
  if (!match || Number(match[1]) !== ordinal) {
    const completeName = name.trim();
    return completeName ? `${base} — ${completeName}` : base;
  }
  const suffix = match[3].trim();
  return suffix ? `${base} — ${suffix}` : base;
}

export function formatCompactProgramDayLabel(
  name: string,
  index: number,
): string {
  const ordinal = index + 1;
  const trimmed = name.trim();
  const match = trimmed.match(/^day\s+(\d+)(?=$|[\s—–\-.:·])/i);
  if (match && Number(match[1]) === ordinal) return `Day ${ordinal}`;
  return trimmed || `Day ${ordinal}`;
}

export function deriveProgramDayWarmupLines(
  dayWarmupNotes: string | null,
  slots: Array<{
    slotLineageId?: string;
    exerciseName: string;
    warmupNotes: string | null;
    warmupSets: WarmupSetDisplayInput[];
  }>,
  dayWarmupItems: ProgramDayWarmupItem[] = [],
  dayLineageId?: string,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const effectiveWarmupItems =
    dayLineageId &&
    hasGeneratedOverviewWarmupItems({
      lineageId: dayLineageId,
      warmupNotes: dayWarmupNotes,
      warmupItems: dayWarmupItems,
    })
      ? []
      : dayWarmupItems;
  if (effectiveWarmupItems.length > 0) {
    const exerciseNameByLineage = new Map(
      slots.flatMap((slot) =>
        slot.slotLineageId
          ? [[slot.slotLineageId, slot.exerciseName] as const]
          : [],
      ),
    );
    for (const item of effectiveWarmupItems) {
      const step = formatWarmupSetLine(item);
      const exerciseName = item.beforeSlotLineageId
        ? exerciseNameByLineage.get(item.beforeSlotLineageId)
        : null;
      addUniqueLine(
        lines,
        seen,
        exerciseName ? `Before ${exerciseName}: ${step}` : step,
      );
    }
  } else {
    for (const line of dayWarmupNotes?.split(/\r?\n/) ?? []) {
      addUniqueLine(lines, seen, line);
    }
  }
  slots.forEach((slot, index) => {
    if (slot.warmupNotes) {
      const note =
        index === 0
          ? slot.warmupNotes
          : `Before ${slot.exerciseName}: ${slot.warmupNotes}`;
      addUniqueLine(lines, seen, note);
    }
    for (const set of slot.warmupSets) {
      addUniqueLine(
        lines,
        seen,
        `Before ${slot.exerciseName}: ${formatWarmupSetLine(set)}`,
      );
    }
  });
  return lines;
}

/** Builds a read-only, serializable view without changing the owned source. */
export function projectProgramPresentation(
  source: ProgramPresentationSource,
): ProgramPresentation {
  const groupById = new Map(source.groups.map((group) => [group.id, group]));
  const days = [...source.days]
    .sort((left, right) => left.orderIdx - right.orderIdx)
    .map((day) => {
      const slots = [...day.slots].sort(
        (left, right) => left.orderIdx - right.orderIdx,
      );
      const memberNamesByGroup = new Map<string, string[]>();
      for (const slot of slots) {
        if (!slot.supersetGroupId) continue;
        const names = memberNamesByGroup.get(slot.supersetGroupId) ?? [];
        names.push(slot.exercise.name);
        memberNamesByGroup.set(slot.supersetGroupId, names);
      }
      return {
        id: day.id,
        lineageId: day.lineageId,
        name: day.name,
        notes: day.notes,
        orderIdx: day.orderIdx,
        intent: day.intent,
        warmupLines: deriveProgramDayWarmupLines(
          day.warmupNotes,
          slots.map((slot) => ({
            slotLineageId: slot.lineageId,
            exerciseName: slot.exercise.name,
            warmupNotes: slot.warmupNotes,
            warmupSets: slot.warmupSets,
          })),
          day.warmupItems ?? [],
          day.lineageId,
        ),
        slots: slots.map((slot) => {
          const group = slot.supersetGroupId
            ? groupById.get(slot.supersetGroupId)
            : null;
          return {
            ...slot,
            superset: group
              ? {
                  ...group,
                  memberNames:
                    memberNamesByGroup.get(group.id) ?? [],
                }
              : null,
          };
        }),
      };
    });
  return {
    program: { ...source.program },
    version: { ...source.version },
    days,
  };
}
