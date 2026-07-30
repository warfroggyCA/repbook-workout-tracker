import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import type {
  ProgramDocument,
  ProgramDocumentDay,
  ProgramDocumentSlot,
} from "@/lib/program-document";
import type { RoutineDraft } from "@/app/actions/setup";
import { formatRestTime } from "@/lib/rest-time";
import {
  programDocumentFromRoutineDraft,
  resizeSetNotes,
} from "@/lib/program-editor-client";
import { splitRoutineBuildRequests } from "@/lib/routine-build-chunks";

export type ProgramUpdateMode = "update" | "replace";

export type ProgramUpdateChange = {
  id: string;
  category: "added" | "changed" | "unchanged" | "decision" | "removed";
  summary: string;
  acceptedByDefault: boolean;
  operation:
    | { kind: "add_day"; day: ProgramDocumentDay }
    | { kind: "update_name"; name: string }
    | { kind: "add_slot"; dayId: string; position: number; slot: ProgramDocumentSlot }
    | { kind: "update_day"; dayId: string; patch: Pick<Partial<ProgramDocumentDay>, "name" | "notes" | "warmupNotes"> }
    | { kind: "update_slot"; dayId: string; slotId: string; patch: Partial<ProgramDocumentSlot> }
    | { kind: "remove_slot"; dayId: string; slotId: string }
    | { kind: "reorder"; dayId: string; slotIds: string[] }
    | { kind: "superset"; dayId: string; group: ProgramDocumentDay["supersets"][number] | null; memberSlotIds: string[] }
    | { kind: "replace"; document: ProgramDocument }
    | { kind: "none" };
};

export type ProgramUpdateProposal = {
  changes: ProgramUpdateChange[];
  warnings: string[];
};

function normalizeV2DaySupersets(day: ProgramDocumentDay): ProgramDocumentDay {
  const counts = new Map<string, number>();
  for (const slot of day.exercises) {
    if (slot.supersetKey) counts.set(slot.supersetKey, (counts.get(slot.supersetKey) ?? 0) + 1);
  }
  const valid = new Set(
    day.supersets
      .filter((group) => (counts.get(group.key) ?? 0) >= 2)
      .map((group) => group.key),
  );
  return {
    ...day,
    supersets: day.supersets.filter((group) => valid.has(group.key)),
    exercises: day.exercises.map((slot) =>
      slot.supersetKey && !valid.has(slot.supersetKey)
        ? { ...slot, supersetKey: null }
        : slot,
    ),
  };
}

function normalized(value: string) {
  return value.toLocaleLowerCase("en").replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function explicitlyNames(text: string, name: string) {
  return exerciseMentions(text, [name]).length > 0;
}

function has(text: string, expression: RegExp) {
  return expression.test(text.toLocaleLowerCase("en"));
}

function replacementSources(text: string): string[] {
  return [...text.matchAll(/\breplace\s+(.+?)\s+with\s+(.+?)(?=\s+[—–-]\s+|\n|$)/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function replacementMatchesExercise(source: string, exerciseName: string) {
  const descriptor = normalized(source).replace(/^current\s+/, "");
  if (!descriptor) return false;
  if (!normalized(source).startsWith("current ")) {
    return explicitlyNames(source, exerciseName);
  }
  const exercise = normalized(exerciseName);
  return descriptor.split(" ").every((token) => exercise.includes(token));
}

type ExerciseMention = {
  name: string;
  start: number;
  end: number;
  exactCanonicalMatch: boolean;
};

const EXERCISE_REFERENCE_MODIFIERS = new Set([
  "barbell",
  "dumbbell",
  "cable",
  "band",
  "bodyweight",
  "kettlebell",
  "machine",
  "seated",
  "standing",
]);

function exerciseReferencePhrases(name: string): string[] {
  const full = normalized(name);
  const tokens = full.split(" ").filter(Boolean);
  const simplified = tokens
    .filter((token) => !EXERCISE_REFERENCE_MODIFIERS.has(token))
    .join(" ");
  const phrases = new Set([full, simplified]);
  if (simplified.includes("incline") && simplified.includes("bench")) {
    phrases.add("incline bench");
  }
  if (full === "barbell back squat") phrases.add("squat");
  return [...phrases].filter(Boolean);
}

function exerciseMentions(text: string, names: string[]) {
  const matches: ExerciseMention[] = [];
  for (const name of new Set(names)) {
    for (const phrase of exerciseReferencePhrases(name)) {
      const tokens = phrase.split(" ").filter(Boolean);
      if (tokens.length === 0) continue;
      const expression = new RegExp(`\\b${tokens.join("[^a-z0-9]+")}\\b`, "gi");
      for (const match of text.matchAll(expression)) {
        if (match.index == null) continue;
        matches.push({
          name,
          start: match.index,
          end: match.index + match[0].length,
          exactCanonicalMatch: normalized(match[0]) === normalized(name),
        });
      }
    }
  }
  matches.sort(
    (left, right) =>
      left.start - right.start ||
      (right.end - right.start) - (left.end - left.start) ||
      Number(right.exactCanonicalMatch) - Number(left.exactCanonicalMatch),
  );
  const mentions: ExerciseMention[] = [];
  for (const match of matches) {
    if (mentions.some((mention) => match.start < mention.end && match.end > mention.start)) continue;
    mentions.push(match);
  }
  return mentions.sort((left, right) => left.start - right.start);
}

function fieldContext(text: string, name: string, mentions: ExerciseMention[]) {
  const targetName = normalized(name);
  const targetMentions = mentions.filter((mention) => normalized(mention.name) === targetName);
  if (new Set(mentions.map((mention) => normalized(mention.name))).size <= 1) {
    return targetMentions.length > 0 ? text : "";
  }
  const boundaries = /[,.;\n]+|\band\b/gi;
  const contexts: string[] = [];
  for (const [index, mention] of mentions.entries()) {
    if (normalized(mention.name) !== targetName) continue;
    const previous = mentions[index - 1];
    const next = mentions[index + 1];
    let start = previous ? mention.start : 0;
    if (previous) {
      const between = text.slice(previous.end, mention.start);
      const matches = [...between.matchAll(boundaries)];
      const boundary = matches.at(-1);
      if (boundary?.index != null) start = previous.end + boundary.index + boundary[0].length;
    }
    let end = next ? next.start : text.length;
    const after = text.slice(mention.end, next?.start ?? text.length);
    const boundary = [...after.matchAll(boundaries)].at(-1);
    if (boundary?.index != null) end = mention.end + boundary.index;
    contexts.push(text.slice(start, end));
  }
  return contexts.join("\n");
}

function explicitRestSeconds(text: string) {
  const minutes = text.match(/(\d+)\s*(?:minutes?|mins?)(?:\s*(\d+)\s*(?:seconds?|secs?))?/i);
  if (minutes) return Math.min(1800, Number(minutes[1]) * 60 + Number(minutes[2] ?? 0));
  const seconds = text.match(/(\d+)\s*(?:seconds?|secs?)/i);
  return seconds ? Math.min(1800, Number(seconds[1])) : null;
}

function fieldPatch(
  current: ProgramDocumentSlot,
  candidate: ProgramDocumentSlot,
  text: string,
) {
  const patch: Partial<ProgramDocumentSlot> = {};
  if (has(text, /\bsets?\b|\d+\s*[x×]\s*\d+/)) patch.sets = candidate.sets;
  if (has(text, /\breps?\b|\brepetitions?\b|\d+\s*[x×]\s*\d+/)) {
    patch.repMin = candidate.repMin;
    patch.repMax = candidate.repMax;
  }
  if (has(text, /\brest\b|\bseconds?\b|\bsecs?\b|\bminutes?\b|\bmins?\b/)) {
    patch.restSec = candidate.restSec;
  }
  if (has(text, /\bload\b|\bweight\b|\d+(?:\.\d+)?\s*(?:lb|lbs|kg)\b/)) {
    patch.targetLoad = candidate.targetLoad;
    patch.targetLoadUnit = candidate.targetLoadUnit;
  }
  if (has(text, /\bnotes?\b|\bcues?\b/)) patch.notes = candidate.notes;
  if (has(text, /\bprogression\b|\bhold targets?\b|\bdouble progression\b/)) {
    patch.progressionRuleId = candidate.progressionRuleId;
  }
  return Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => current[key as keyof ProgramDocumentSlot] !== value),
  ) as Partial<ProgramDocumentSlot>;
}

function slotSummary(
  name: string,
  current: ProgramDocumentSlot,
  patch: Partial<ProgramDocumentSlot>,
) {
  const details: string[] = [];
  if (patch.sets != null) details.push(`${patch.sets} sets`);
  if (patch.sets != null || patch.repMin != null || patch.repMax != null) {
    details.push(
      `${patch.repMin ?? current.repMin}–${patch.repMax ?? current.repMax} reps`,
    );
  }
  if (patch.restSec != null) details.push(`${formatRestTime(patch.restSec)} rest`);
  if ("targetLoad" in patch) details.push(patch.targetLoad == null ? "no target load" : `${patch.targetLoad} ${patch.targetLoadUnit ?? ""}`.trim());
  if (patch.progressionRuleId) details.push(patch.progressionRuleId === "hold" ? "Hold targets" : "Double progression");
  if ("notes" in patch) details.push("exercise notes");
  return `Change ${name}: ${details.join(", ")}`;
}

export function buildProgramUpdateProposal(args: {
  current: ProgramDocument;
  candidate: RoutineDraft;
  library: ExerciseDiscoveryItem[];
  sourceText: string;
  mode: ProgramUpdateMode;
  candidateProgramName?: string | null;
  createId?: () => string;
}): ProgramUpdateProposal {
  const createId = args.createId ?? (() => crypto.randomUUID());
  const candidateDocument = programDocumentFromRoutineDraft(args.current, args.candidate, createId);
  if (args.candidateProgramName?.trim()) candidateDocument.name = args.candidateProgramName.trim();
  if (args.mode === "replace") {
    return {
      changes: [{ id: createId(), category: "changed", summary: "Replace the entire Program; unmentioned days and exercises may be removed", acceptedByDefault: false, operation: { kind: "replace", document: candidateDocument } }],
      warnings: ["Full replacement is deliberately off by default. Review the complete outline before selecting it."],
    };
  }

  const names = new Map(args.library.map((item) => [item.id, item.name]));
  const sourceParts = splitRoutineBuildRequests(args.sourceText);
  const changes: ProgramUpdateChange[] = [];
  if (candidateDocument.name !== args.current.name && has(args.sourceText, /\brename\b|\bprogram name\b|\bcall (?:the|my|this) program\b/)) {
    changes.push({ id: createId(), category: "changed", summary: `Rename Program to ${candidateDocument.name}`, acceptedByDefault: true, operation: { kind: "update_name", name: candidateDocument.name } });
  }
  for (const [candidateDayIndex, candidateDay] of candidateDocument.days.entries()) {
    const daySource = sourceParts.length === candidateDocument.days.length
      ? sourceParts[candidateDayIndex]!
      : args.sourceText;
    const dayExerciseMentions = exerciseMentions(daySource, [...names.values()]);
    let dayMatches = args.current.days.filter((day) => normalized(day.name) === normalized(candidateDay.name));
    if (dayMatches.length === 0) {
      const mentionedDays = args.current.days.filter((day) => explicitlyNames(args.sourceText, day.name));
      if (mentionedDays.length === 1) dayMatches = mentionedDays;
    }
    if (dayMatches.length === 0) {
      const explicitlyNamedExerciseIds = candidateDay.exercises
        .filter((slot) => explicitlyNames(daySource, names.get(slot.exerciseId) ?? ""))
        .map((slot) => slot.exerciseId);
      if (explicitlyNamedExerciseIds.length > 0) {
        dayMatches = args.current.days.filter((day) =>
          explicitlyNamedExerciseIds.some((exerciseId) => day.exercises.some((slot) => slot.exerciseId === exerciseId)),
        );
      }
    }
    if (dayMatches.length > 1) {
      changes.push({ id: createId(), category: "decision", summary: `Choose which “${candidateDay.name}” day the pasted changes belong to`, acceptedByDefault: false, operation: { kind: "none" } });
      continue;
    }
    const currentDay = dayMatches[0];
    if (!currentDay) {
      const explicitAdd = has(daySource, /\badd\b|\bnew\b|\bcreate\b/) && explicitlyNames(daySource, candidateDay.name);
      changes.push({ id: createId(), category: explicitAdd ? "added" : "decision", summary: `${explicitAdd ? "Add" : "Review possible new"} day: ${candidateDay.name}`, acceptedByDefault: explicitAdd, operation: explicitAdd ? { kind: "add_day", day: candidateDay } : { kind: "none" } });
      continue;
    }
    const dayPatch: Pick<Partial<ProgramDocumentDay>, "name" | "notes" | "warmupNotes"> = {};
    if (explicitlyNames(daySource, currentDay.name) && has(daySource, /\bwarm\s*-?up\b/) && currentDay.warmupNotes !== candidateDay.warmupNotes) dayPatch.warmupNotes = candidateDay.warmupNotes;
    if (explicitlyNames(daySource, currentDay.name) && has(daySource, /\bday notes?\b/) && currentDay.notes !== candidateDay.notes) dayPatch.notes = candidateDay.notes;
    if (Object.keys(dayPatch).length) changes.push({ id: createId(), category: "changed", summary: `Change ${currentDay.name}: ${Object.keys(dayPatch).map((key) => key === "warmupNotes" ? "warm-up" : "day notes").join(", ")}`, acceptedByDefault: true, operation: { kind: "update_day", dayId: currentDay.lineageId, patch: dayPatch } });
    const candidateByExercise = new Map<string, ProgramDocumentSlot[]>();
    for (const slot of candidateDay.exercises) candidateByExercise.set(slot.exerciseId, [...(candidateByExercise.get(slot.exerciseId) ?? []), slot]);
    const currentByExercise = new Map<string, ProgramDocumentSlot[]>();
    for (const slot of currentDay.exercises) currentByExercise.set(slot.exerciseId, [...(currentByExercise.get(slot.exerciseId) ?? []), slot]);
    const proposedOrder: string[] = [];

    const matchedCurrentSlot = (slot: ProgramDocumentSlot) => {
      const candidates = candidateByExercise.get(slot.exerciseId) ?? [];
      const currents = currentByExercise.get(slot.exerciseId) ?? [];
      return candidates.length === 1 && currents.length === 1 ? currents[0] : null;
    };
    const insertionPosition = (candidateIndex: number) => {
      for (let index = candidateIndex - 1; index >= 0; index -= 1) {
        const match = matchedCurrentSlot(candidateDay.exercises[index]!);
        if (match) return currentDay.exercises.findIndex((slot) => slot.lineageId === match.lineageId) + 1;
      }
      for (let index = candidateIndex + 1; index < candidateDay.exercises.length; index += 1) {
        const match = matchedCurrentSlot(candidateDay.exercises[index]!);
        if (match) return currentDay.exercises.findIndex((slot) => slot.lineageId === match.lineageId);
      }
      return currentDay.exercises.length;
    };

    for (const [candidateIndex, candidateSlot] of candidateDay.exercises.entries()) {
      const name = names.get(candidateSlot.exerciseId) ?? "Unavailable exercise";
      const candidates = candidateByExercise.get(candidateSlot.exerciseId) ?? [];
      const currents = currentByExercise.get(candidateSlot.exerciseId) ?? [];
      if (candidates.length > 1 || currents.length > 1) {
        if (explicitlyNames(daySource, name)) changes.push({ id: createId(), category: "decision", summary: `${name} appears more than once on ${currentDay.name}; choose the intended occurrence`, acceptedByDefault: false, operation: { kind: "none" } });
        continue;
      }
      const currentSlot = currents[0];
      if (!currentSlot) {
        if (explicitlyNames(daySource, name)) {
          changes.push({ id: createId(), category: "added", summary: `Add ${name} to ${currentDay.name}`, acceptedByDefault: true, operation: { kind: "add_slot", dayId: currentDay.lineageId, position: insertionPosition(candidateIndex), slot: candidateSlot } });
        }
        continue;
      }
      proposedOrder.push(currentSlot.lineageId);
      if (!explicitlyNames(daySource, name)) continue;
      const patch = fieldPatch(currentSlot, candidateSlot, fieldContext(daySource, name, dayExerciseMentions));
      changes.push({ id: createId(), category: Object.keys(patch).length ? "changed" : "unchanged", summary: Object.keys(patch).length ? slotSummary(name, currentSlot, patch) : `${name} is unchanged`, acceptedByDefault: Object.keys(patch).length > 0, operation: Object.keys(patch).length ? { kind: "update_slot", dayId: currentDay.lineageId, slotId: currentSlot.lineageId, patch } : { kind: "none" } });
    }

    if (has(daySource, /\breorder\b|\bmove\b|\bbefore\b|\bafter\b/) && proposedOrder.length === currentDay.exercises.length && proposedOrder.some((id, index) => currentDay.exercises[index]?.lineageId !== id)) {
      changes.push({ id: createId(), category: "changed", summary: `Reorder exercises on ${currentDay.name}`, acceptedByDefault: true, operation: { kind: "reorder", dayId: currentDay.lineageId, slotIds: proposedOrder } });
    }

    if (has(daySource, /\bsuperset\b|\btri[ -]?set\b|\bpair(?:ing|ed)?\b|\bgroup(?:ed|ing)?\b/)) {
      const removingGroup = has(daySource, /\bremove\b|\bunpair\b|\bdissolve\b/);
      const explicitlyNamedSlots = currentDay.exercises.filter((slot) => explicitlyNames(daySource, names.get(slot.exerciseId) ?? ""));
      if (removingGroup && explicitlyNamedSlots.length > 0) {
        changes.push({ id: createId(), category: "changed", summary: `Remove superset grouping from the named exercises on ${currentDay.name}`, acceptedByDefault: false, operation: { kind: "superset", dayId: currentDay.lineageId, group: null, memberSlotIds: explicitlyNamedSlots.map((slot) => slot.lineageId) } });
      } else {
        for (const candidateGroup of candidateDay.supersets) {
          const candidateMembers = candidateDay.exercises.filter((slot) => slot.supersetKey === candidateGroup.key);
          const memberSlotIds = candidateMembers.flatMap((candidateSlot) => {
            const currentMatches = currentByExercise.get(candidateSlot.exerciseId) ?? [];
            return currentMatches.length === 1
              ? [currentMatches[0].lineageId]
              : currentMatches.length === 0 && explicitlyNames(daySource, names.get(candidateSlot.exerciseId) ?? "")
                ? [candidateSlot.lineageId]
                : [];
          });
          const allExplicit = candidateMembers.length >= 2 && candidateMembers.every((slot) => explicitlyNames(daySource, names.get(slot.exerciseId) ?? ""));
          if (memberSlotIds.length === candidateMembers.length && allExplicit) {
            changes.push({ id: createId(), category: "changed", summary: `Group ${candidateMembers.map((slot) => names.get(slot.exerciseId) ?? "exercise").join(" + ")} as ${candidateGroup.name}`, acceptedByDefault: true, operation: { kind: "superset", dayId: currentDay.lineageId, group: { ...candidateGroup, key: createId(), restAfterRoundSec: explicitRestSeconds(daySource) ?? candidateGroup.restAfterRoundSec }, memberSlotIds } });
          } else if (candidateMembers.some((slot) => explicitlyNames(daySource, names.get(slot.exerciseId) ?? ""))) {
            changes.push({ id: createId(), category: "decision", summary: `Confirm every intended member of ${candidateGroup.name} on ${currentDay.name}`, acceptedByDefault: false, operation: { kind: "none" } });
          }
        }
      }
    }

    for (const replacementSource of replacementSources(daySource)) {
      const matchingSlots = currentDay.exercises.filter((slot) =>
        replacementMatchesExercise(
          replacementSource,
          names.get(slot.exerciseId) ?? "",
        ),
      );
      if (matchingSlots.length === 1) {
        const slot = matchingSlots[0]!;
        changes.push({
          id: createId(),
          category: "removed",
          summary: `Replace ${names.get(slot.exerciseId) ?? "the current exercise"} on ${currentDay.name}`,
          acceptedByDefault: true,
          operation: {
            kind: "remove_slot",
            dayId: currentDay.lineageId,
            slotId: slot.lineageId,
          },
        });
      } else if (matchingSlots.length > 1) {
        changes.push({
          id: createId(),
          category: "decision",
          summary: `Choose which “${replacementSource}” exercise to replace on ${currentDay.name}`,
          acceptedByDefault: false,
          operation: { kind: "none" },
        });
      }
    }
  }

  const removeIntent = has(args.sourceText, /\bremove\b|\bdelete\b|\bdrop\b|\btake out\b/) && !has(args.sourceText, /\bsuperset\b|\bunpair\b/);
  if (removeIntent) {
    for (const day of args.current.days) for (const slot of day.exercises) {
      const name = names.get(slot.exerciseId) ?? "Unavailable exercise";
      if (explicitlyNames(args.sourceText, name)) changes.push({ id: createId(), category: "removed", summary: `Remove ${name} from ${day.name}`, acceptedByDefault: false, operation: { kind: "remove_slot", dayId: day.lineageId, slotId: slot.lineageId } });
    }
  }

  if (changes.length === 0) changes.push({ id: createId(), category: "unchanged", summary: "No explicit safe changes were found; the current Program remains unchanged", acceptedByDefault: false, operation: { kind: "none" } });
  return { changes, warnings: [] };
}

export function applyProgramUpdateChanges(
  document: ProgramDocument,
  changes: ProgramUpdateChange[],
  acceptedIds: Set<string>,
) {
  let next = structuredClone(document);
  const appliedAddPositions = new Map<string, number[]>();
  for (const change of changes) {
    if (!acceptedIds.has(change.id)) continue;
    const operation = change.operation;
    if (operation.kind === "replace") next = operation.document;
    if (operation.kind === "update_name") next.name = operation.name;
    if (operation.kind === "add_day") next.days.push(operation.day);
    if (operation.kind === "update_day") next.days = next.days.map((day) => day.lineageId === operation.dayId ? { ...day, ...operation.patch } : day);
    if (operation.kind === "add_slot") {
      const positions = appliedAddPositions.get(operation.dayId) ?? [];
      const position = operation.position + positions.filter((prior) => prior <= operation.position).length;
      next.days = next.days.map((day) => day.lineageId === operation.dayId ? { ...day, exercises: [...day.exercises.slice(0, position), operation.slot, ...day.exercises.slice(position)] } : day);
      appliedAddPositions.set(operation.dayId, [...positions, operation.position]);
    }
    if (operation.kind === "update_slot") next.days = next.days.map((day) => day.lineageId === operation.dayId ? { ...day, exercises: day.exercises.map((slot) => {
      if (slot.lineageId !== operation.slotId) return slot;
      const sets = operation.patch.sets ?? slot.sets;
      return {
        ...slot,
        ...operation.patch,
        setNotes: operation.patch.sets
          ? resizeSetNotes(slot.setNotes, operation.patch.sets)
          : slot.setNotes,
        intent: operation.patch.sets && slot.intent.minimumDose.unit === "sets"
          ? {
              ...slot.intent,
              minimumDose: {
                ...slot.intent.minimumDose,
                value: Math.min(slot.intent.minimumDose.value, sets),
              },
              idealDose: {
                ...slot.intent.idealDose,
                value: Math.max(sets, slot.intent.minimumDose.value),
              },
            }
          : slot.intent,
      };
    }) } : day);
    if (operation.kind === "remove_slot") next.days = next.days.map((day) => day.lineageId === operation.dayId ? normalizeV2DaySupersets({ ...day, exercises: day.exercises.filter((slot) => slot.lineageId !== operation.slotId) }) : day).filter((day) => day.exercises.length > 0);
    if (operation.kind === "reorder") next.days = next.days.map((day) => day.lineageId === operation.dayId ? { ...day, exercises: operation.slotIds.map((id) => day.exercises.find((slot) => slot.lineageId === id)).filter((slot): slot is ProgramDocumentSlot => Boolean(slot)) } : day);
    if (operation.kind === "superset") next.days = next.days.map((day) => {
      if (day.lineageId !== operation.dayId) return day;
      const selected = new Set(operation.memberSlotIds);
      const cleared = normalizeV2DaySupersets({ ...day, exercises: day.exercises.map((slot) => selected.has(slot.lineageId) ? { ...slot, supersetKey: null } : slot) });
      if (!operation.group) return cleared;
      const members = cleared.exercises.filter((slot) => selected.has(slot.lineageId)).map((slot) => ({ ...slot, supersetKey: operation.group!.key }));
      const first = cleared.exercises.findIndex((slot) => selected.has(slot.lineageId));
      const exercises = cleared.exercises.filter((slot) => !selected.has(slot.lineageId));
      exercises.splice(Math.max(0, first), 0, ...members);
      return { ...cleared, supersets: [...cleared.supersets, operation.group], exercises };
    });
  }
  return next;
}
