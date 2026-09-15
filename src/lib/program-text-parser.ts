import {
  programUpdateSchema,
  updateWarmupSchema,
  type ProgramTextUpdate,
  type ProgramUpdateOperation,
} from "@/ai/tasks/program-update/schema";
import type { ProgramDocumentV3 } from "@/lib/program-document";
import { normalizeExerciseText } from "@/services/exercise-map";
import type { z } from "zod";

type Day = ProgramDocumentV3["days"][number];
type Slot = Day["exercises"][number];
type Warmup = z.infer<typeof updateWarmupSchema>;
export type TextParserExercise = {
  id: string;
  name: string;
  aliases?: string[];
  available: boolean;
  metricType: string;
};
type Line = { text: string; source: string };
type Target = { day: Day; slot: Slot | null };
type Preparation = Target & {
  source: string;
  notes: string[];
  items: Warmup[];
  invalid: boolean;
};

// Soft-wrapped pasted paragraphs retain their original source for review.
function readLines(input: string): Line[] {
  const result: Line[] = [];
  let separated = true;
  for (const source of input.split(/\r?\n/)) {
    if (!source.trim()) {
      separated = true;
      continue;
    }
    const text = source.trim().replace(/^(?:[•*\-]|#{1,6})\s+/, "");
    const bullet = /^\s*[•*\-]\s+/.test(source);
    const command =
      /^(?:before|immediately before|day\b|change\b|set\b|replace\b|remove\b|move\b|keep\b|leave\b|then\b|for\b|these\b)/i.test(
        text,
      );
    if (
      !separated &&
      !bullet &&
      !command &&
      result.length &&
      (/^\s{2,}\S/.test(source) || /^[a-z]/.test(text))
    ) {
      const previous = result[result.length - 1];
      previous.text += ` ${text}`;
      previous.source += `\n${source}`;
    } else result.push({ text, source: source.trim() });
    separated = false;
  }
  return result;
}

const equipmentWords = new Set([
  "barbell",
  "dumbbell",
  "kettlebell",
  "cable",
  "machine",
  "bb",
  "db",
  "kb",
]);
function nameTokens(value: string) {
  return normalizeExerciseText(value.replace(/^(?:the\s+)?loaded\s+/i, ""))
    .replace(/\bbb\b/g, "barbell")
    .replace(/\bdb\b/g, "dumbbell")
    .replace(/\bkb\b/g, "kettlebell")
    .split(" ")
    .filter(Boolean);
}
function sameMovement(reference: string, name: string): boolean {
  const raw = nameTokens(reference);
  const candidate = nameTokens(name);
  const exact = (a: string[], b: string[]) =>
    a.slice().sort().join(" ") === b.slice().sort().join(" ");
  if (exact(raw, candidate)) return true;
  // An unqualified reference may identify a unique slot already in this day.
  // Never strip grip, incline, support, unilateral or other variant words.
  return (
    !raw.some((word) => equipmentWords.has(word)) &&
    exact(
      raw,
      candidate.filter((word) => !equipmentWords.has(word)),
    )
  );
}

function addNote(notes: string[], value: string) {
  const text = value.trim();
  if (text && !notes.includes(text)) notes.push(text);
}

function preparationItem(text: string): Warmup | null {
  const item: Warmup = {
    label: "Preparation",
    reps: null,
    load: null,
    loadUnit: null,
    loadPercent: null,
    loadText: null,
    notes: null,
  };
  const cleaned = text.trim().replace(/[.;]$/, "");
  if (
    /^(?:rest\b|these\b|then\b|do not\b|remove\b|use the same\b|take longer\b)/i.test(
      cleaned,
    )
  )
    return null;
  const numeric =
    /^(\d+(?:\.\d+)?)\s*(lb|lbs|kg)\s*[×x]\s*(\d+)(?:\s*[–—-]\s*(\d+))?(.*)$/i.exec(
      cleaned,
    );
  if (numeric) {
    if (
      Number(numeric[3]) > 1000 ||
      (numeric[4] &&
        (Number(numeric[3]) > Number(numeric[4]) ||
          Number(numeric[4]) > 1000)) ||
      /^[\d.,/–—-]|^\s*[×x]\s*\d/.test(numeric[5])
    )
      return null;
    item.label = "Preparation set";
    item.load = Number(numeric[1]);
    item.loadUnit = numeric[2].toLowerCase() === "kg" ? "kg" : "lb";
    item.reps = numeric[4] ? null : Number(numeric[3]);
    item.notes =
      [
        numeric[4] ? `${numeric[3]}–${numeric[4]} repetitions` : "",
        numeric[5].trim(),
      ]
        .filter(Boolean)
        .join("; ") || null;
    return updateWarmupSchema.safeParse(item).success ? item : null;
  }
  if (/^[-−+]?\d/.test(cleaned)) return null;
  // A full instruction is a preparation item only when it supplies a dose.
  // Qualifiers/ranges stay verbatim when the storage fields cannot express them.
  if (
    !/(?:[×x]\s*\d|\b\d+(?:\s*[–—-]\s*\d+)?\s*(?:easy\s+)?(?:reps?|repetitions?|minutes?|seconds?|forward|backward)\b)/i.test(
      cleaned,
    )
  )
    return null;
  const multiplied = /^(.+?)\s*[×x]\s*(\d+)(?:\s*[–—-]\s*(\d+))?(.*)$/i.exec(
    cleaned,
  );
  if (multiplied) {
    if (
      Number(multiplied[2]) > 1000 ||
      (multiplied[3] &&
        (Number(multiplied[2]) > Number(multiplied[3]) ||
          Number(multiplied[3]) > 1000)) ||
      /^[\d.,/–—-]|^\s*[×x]\s*\d/.test(multiplied[4])
    )
      return null;
    item.label = multiplied[1].replace(/^(?:use\s+)?(?:one\s+)?/i, "");
    item.reps = multiplied[3] ? null : Number(multiplied[2]);
    item.notes =
      [
        multiplied[3] ? `${multiplied[2]}–${multiplied[3]} repetitions` : "",
        multiplied[4].trim(),
      ]
        .filter(Boolean)
        .join("; ") || null;
  } else {
    const colon = /^([^:]+):\s*(.+)$/.exec(cleaned);
    item.label = colon?.[1] ?? cleaned;
    item.notes = colon?.[2] ?? null;
  }
  const percent =
    /(?:approximately\s+|about\s+)?(?:half(?:\s+(?:of\s+)?the)?\s+working\s+weight|(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+)?)?working\s+weight)/i.exec(
      cleaned,
    );
  if (percent) item.loadPercent = percent[1] ? Number(percent[1]) : 50;
  else if (/\bbody\s?weight\b/i.test(cleaned)) item.loadText = "Bodyweight";
  else if (/\b(?:light(?:er)?|unloaded)\b/i.test(cleaned)) {
    item.loadText = /\bunloaded\b/i.test(cleaned)
      ? "Unloaded"
      : /\bkettlebell\b/i.test(cleaned)
        ? "Light owned kettlebell"
        : "Lighter owned load";
  }
  return updateWarmupSchema.safeParse(item).success ? item : null;
}

function seconds(text: string): number | null {
  const pattern = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return null;
  if (
    text
      .replace(pattern, "")
      .replace(/\band\b/gi, "")
      .trim()
  )
    return null;
  const total = matches.reduce(
    (sum, match) => sum + Number(match[1]) * (/^m/i.test(match[2]) ? 60 : 1),
    0,
  );
  return Number.isSafeInteger(total) && total <= 1800 ? total : null;
}

/** Local, bounded interpretation of authored edits. No provider or data writes. */
export function parseProgramTextUpdate(
  document: ProgramDocumentV3,
  input: string,
  library: ReadonlyArray<TextParserExercise>,
  activeDayId: string | null = null,
): ProgramTextUpdate {
  const changes: ProgramTextUpdate["changes"] = [];
  const questions: string[] = [];
  const catalog = new Map(library.map((exercise) => [exercise.id, exercise]));
  const preparations = new Map<string, Preparation>();
  const globalNotes: string[] = [];
  const lines = readLines(input);
  let days: Day[] | null = null;
  let current: Preparation[] = [];
  let section: "rules" | "general" | "other" | "day" | null = null;
  let conditional = false;
  const question = (message: string) => {
    const bounded = message.slice(0, 500);
    if (!questions.includes(bounded) && questions.length < 20)
      questions.push(bounded);
  };
  const key = (target: Target) =>
    `${target.day.lineageId}:${target.slot?.lineageId ?? "general"}`;
  const label = (target: Target) =>
    `${target.day.name}${target.slot ? ` · ${catalog.get(target.slot.exerciseId)?.name ?? "Exercise"}` : " · general preparation"}`;
  const resolveDay = (name: string): Day[] => {
    const normalized = normalizeExerciseText(name.replace(/\s+day$/i, ""));
    if (/^(?:this|current)(?: day)?$/i.test(normalized))
      return document.days.filter((day) => day.lineageId === activeDayId);
    const exact = document.days.filter(
      (day) => normalizeExerciseText(day.name) === normalized,
    );
    if (exact.length) return exact;
    const marker = /^(?:day\s+)?([a-z]|\d+)(?:\s*[—–:-].*)?$/i.exec(name);
    if (marker) {
      const named = document.days.filter((day) =>
        new RegExp(`^day\\s+${marker[1]}(?:\\b|\\s)`, "i").test(day.name),
      );
      if (named.length) return named;
      const index = /^\d+$/.test(marker[1])
        ? Number(marker[1]) - 1
        : marker[1].toUpperCase().charCodeAt(0) - 65;
      return document.days[index] ? [document.days[index]] : [];
    }
    return document.days.filter(
      (day) =>
        normalizeExerciseText(day.name).replace(/^day\s+\w+\s*/, "") ===
        normalized,
    );
  };
  const resolve = (
    reference: string,
    scope: Day[],
    eachDay = false,
  ): Target[] => {
    const matches = scope.flatMap((day) =>
      day.exercises
        .filter((slot) => {
          const exercise = catalog.get(slot.exerciseId);
          return (
            exercise &&
            [exercise.name, ...(exercise.aliases ?? [])].some((name) =>
              sameMovement(reference, name),
            )
          );
        })
        .map((slot) => ({ day, slot })),
    );
    if (!matches.length) {
      question(
        `“${reference}” does not identify an exercise in ${scope.length === 1 ? scope[0].name : "the current Program"}. Which current exercise should receive this instruction?`,
      );
      return [];
    }
    if (
      (!eachDay && matches.length !== 1) ||
      (eachDay &&
        new Set(matches.map((target) => target.day.lineageId)).size !==
          matches.length)
    ) {
      question(
        `“${reference}” matches more than one exercise. Specify the day and exact exercise: ${matches.map(label).join("; ")}.`,
      );
      return [];
    }
    return matches;
  };
  const startPreparation = (targets: Target[], source: string) =>
    targets
      .map((target) => {
        const existing = preparations.get(key(target));
        if (existing) {
          existing.invalid = true;
          question(
            `More than one preparation update targets ${label(target)}. Combine the instructions for that exercise; its preparation has been left unchanged.`,
          );
          return null;
        }
        const prep: Preparation = {
          ...target,
          source,
          notes: [],
          items: [],
          invalid: false,
        };
        preparations.set(key(target), prep);
        return prep;
      })
      .filter((prep): prep is Preparation => prep !== null);
  const consumePreparation = (line: Line) => {
    if (conditional && !current.length) return;
    if (!current.length) {
      question(`Where should this preparation go: “${line.text}”?`);
      return;
    }
    if (
      /^(?:then\s+(?:the\s+)?working sets|do not add this preparation set to the working-set count)[.!]?$/i.test(
        line.text,
      )
    )
      return;
    const item = preparationItem(line.text);
    for (const prep of current) {
      // The original heading is the evidence quote. The structured items and
      // notes below it are shown in full in the proposal summary.
      if (item) prep.items.push({ ...item });
      else if (/^(?:\d|[-−]\d)|[×x]\s*\d/.test(line.text)) {
        prep.invalid = true;
        question(
          `The preparation dose for ${label(prep)} could not be read safely: “${line.text}”. Its preparation has been left unchanged.`,
        );
      } else addNote(prep.notes, line.text);
    }
  };
  const addChange = (
    line: Line,
    operations: ProgramUpdateOperation[],
    reason: string,
  ) => {
    if (operations.length)
      changes.push({
        reason,
        sourceQuote: line.source.slice(0, 1000),
        operations,
      });
  };

  for (const line of lines) {
    const text = line.text;
    if (/^general rules\s*:?(?:\s*)$/i.test(text)) {
      section = "rules";
      current = [];
      continue;
    }
    if (
      /^(?:start of each day|start of every day|general warm[ -]?up)(?:\b|\s*:)/i.test(
        text,
      )
    ) {
      section = "general";
      conditional = false;
      current = startPreparation(
        document.days.map((day) => ({ day, slot: null })),
        line.source,
      );
      continue;
    }
    if (/^other exercise preparation\s*:?(?:\s*)$/i.test(text)) {
      section = "other";
      days = null;
      current = [];
      continue;
    }
    const dayHeader = /^day\s+([a-z]|\d+)\b(?:\s*[—–:-].*)?$/i.exec(text);
    if (dayHeader) {
      days = resolveDay(`Day ${dayHeader[1]}`);
      section = "day";
      current = [];
      conditional = false;
      if (days.length !== 1) {
        question(`Which Program day is “${text}”?`);
        days = [];
      }
      continue;
    }
    if (/^after (?:the )?general warm[ -]?up:?$/i.test(text)) {
      current = [];
      continue;
    }
    const conditionalHeader =
      /^for (?:the )?(?:proposed\s+)?(.+?),?\s*(?:if\s+.+|$)/i.exec(text);
    if (conditionalHeader && /\b(?:if|proposed)\b/i.test(text)) {
      const name = conditionalHeader[1].replace(/,$/, "").trim();
      current = [];
      conditional = true;
      question(
        `Conditional preparation for “${name}” is pending. Confirm the substitution before adding its preparation; no working exercise has been added or replaced.`,
      );
      continue;
    }
    const before =
      /^(?:immediately\s+)?before\s+(?:the\s+)?(?:first\s+)?(.+?)(?:\s+of the day)?\s*[:,]\s*(.*)$/i.exec(
        text,
      );
    if (before) {
      conditional = false;
      const references = before[1].split(/\s+and\s+/i);
      const scope = days ?? document.days;
      const targets = references.flatMap((reference) =>
        resolve(
          reference,
          scope,
          section === "other" || /\b(?:each|every|of the day)\b/i.test(text),
        ),
      );
      current = startPreparation(targets, line.source);
      if (before[2])
        consumePreparation({ text: before[2], source: line.source });
      continue;
    }
    if (section === "rules") {
      addNote(globalNotes, text);
      continue;
    }
    if (/^remove\b.*\bwarm[ -]?up\b/i.test(text) && /\bif\b/i.test(text)) {
      question(
        `Conditional removal needs a decision: “${text}”. The parser cannot establish why an existing preparation was added. Review the replacement preparation before applying it.`,
      );
      continue;
    }
    if (
      /^(?:other accessories|never force|round preparation loads)/i.test(text)
    ) {
      addNote(globalNotes, text);
      continue;
    }
    if (
      /^cable[ -]leg[ -]curl preparation repetitions are per side[.]?$/i.test(
        text,
      )
    ) {
      for (const prep of preparations.values())
        if (
          prep.slot &&
          /cable.*leg.*curl/i.test(
            catalog.get(prep.slot.exerciseId)?.name ?? "",
          )
        )
          addNote(prep.notes, text);
      continue;
    }
    if (
      /^(?:warm[ -]?up update|update warm[ -]?up only|keep\b|leave\b|do not duplicate)/i.test(
        text,
      )
    ) {
      // Preservation rules are not edits. Preparation-specific rules are retained.
      if (
        /warm[ -]?up|preparation/i.test(text) &&
        !/^warm[ -]?up update/i.test(text)
      )
        addNote(globalNotes, text);
      continue;
    }
    if (
      (current.length || conditional) &&
      !/^(?:change|set|update)\b/i.test(text)
    ) {
      consumePreparation(line);
      continue;
    }

    let instruction = text;
    let workScope = days ?? document.days;
    const onDay = /^on\s+(.+?)\s*[,;:]\s*(.+)$/i.exec(instruction);
    if (onDay) {
      workScope = resolveDay(onDay[1]);
      instruction = onDay[2];
      if (workScope.length !== 1) {
        question(`Which Program day is “${onDay[1]}”?`);
        continue;
      }
    }
    // Separate a trailing preservation sentence without interpreting its values.
    instruction = instruction
      .replace(/\.\s*(?:leave|keep)\b.*$/i, "")
      .replace(/[.]$/, "");
    const prescription =
      /^(?:change|set|update)\s+(.+?)\s+to\s+(\d+)\s+(?:working\s+)?sets?\s+(?:of\s+)?(\d+)(?:\s*[–—-]\s*(\d+))?\s*(?:reps?|repetitions?)\b(.*)$/i.exec(
        instruction,
      );
    if (prescription) {
      if (
        Number(prescription[2]) < 1 ||
        Number(prescription[2]) > 20 ||
        Number(prescription[3]) < 1 ||
        Number(prescription[4] ?? prescription[3]) > 100 ||
        Number(prescription[3]) > Number(prescription[4] ?? prescription[3])
      ) {
        question(
          `Use 1–20 working sets and an ordered range of 1–100 repetitions: “${text}”.`,
        );
        continue;
      }
      const targets = resolve(prescription[1], workScope);
      for (const target of targets) {
        if (!target.slot) continue;
        if (target.slot.supersetKey) {
          question(
            `Changing working sets for ${label(target)} also affects its superset. Specify the group's rounds together.`,
          );
          continue;
        }
        if (target.slot.timedPrescription) {
          question(
            `${label(target)} is timed work. Specify its duration rather than repetitions.`,
          );
          continue;
        }
        const operations: ProgramUpdateOperation[] = [
          {
            kind: "slot_number",
            dayId: target.day.lineageId,
            slotId: target.slot.lineageId,
            field: "sets",
            value: Number(prescription[2]),
          },
          {
            kind: "reps",
            dayId: target.day.lineageId,
            slotId: target.slot.lineageId,
            min: Number(prescription[3]),
            max: Number(prescription[4] ?? prescription[3]),
          },
        ];
        const tail = prescription[5];
        if (tail.trim()) {
          const rest = /^(?:\s+(?:with|and))?\s+(.+?)\s+rest$/i.exec(tail);
          const restSec = rest ? seconds(rest[1]) : null;
          if (restSec === null) {
            question(
              `Clarify the rest or loading instruction for ${label(target)}: “${tail.trim()}”.`,
            );
            continue;
          }
          operations.push({
            kind: "slot_number",
            dayId: target.day.lineageId,
            slotId: target.slot.lineageId,
            field: "restSec",
            value: restSec,
          });
        }
        addChange(
          line,
          operations,
          `Update working prescription for ${label(target)}`,
        );
      }
      continue;
    }
    const singleTarget = /^(?:change|set|update)\s+(.+?)\s+to\s+(.+)$/i.exec(
      instruction,
    );
    if (singleTarget) {
      const dose =
        /^(\d+)(?:\s*[–—-]\s*(\d+))?\s+(sets?|reps?|repetitions?)$/i.exec(
          singleTarget[2],
        );
      const rest = /^(.+?)\s+rest$/i.exec(singleTarget[2]);
      if (dose || rest) {
        const restSec = rest ? seconds(rest[1]) : null;
        const min = dose ? Number(dose[1]) : 0;
        const max = dose ? Number(dose[2] ?? dose[1]) : 0;
        const sets = dose && /^sets?$/i.test(dose[3]);
        if (
          (rest && restSec === null) ||
          (dose &&
            (min < 1 ||
              max < min ||
              max > (sets ? 20 : 100) ||
              (sets && !!dose[2])))
        ) {
          question(
            `Clarify the numeric target: “${text}”. Use exact set/rest targets and ordered repetition ranges.`,
          );
          continue;
        }
        for (const target of resolve(singleTarget[1], workScope)) {
          if (!target.slot) continue;
          if (target.slot.supersetKey && (sets || rest)) {
            question(
              `Specify the group's rounds/rest for ${label(target)}. Its group prescription is unchanged.`,
            );
            continue;
          }
          if (dose && !sets && target.slot.timedPrescription) {
            question(
              `${label(target)} is timed work. Specify a duration in the editor.`,
            );
            continue;
          }
          const base = {
            dayId: target.day.lineageId,
            slotId: target.slot.lineageId,
          };
          const operation: ProgramUpdateOperation = rest
            ? {
                ...base,
                kind: "slot_number",
                field: "restSec",
                value: restSec!,
              }
            : sets
              ? { ...base, kind: "slot_number", field: "sets", value: min }
              : { ...base, kind: "reps", min, max };
          addChange(
            line,
            [operation],
            `Update working target for ${label(target)}`,
          );
        }
        continue;
      }
    }
    const load =
      /^(?:change|set|update)\s+(.+?)(?:\s+(?:weight|load))?\s+to\s+(\d+(?:\.\d+)?)\s*(lb|lbs|kg)$/i.exec(
        instruction,
      );
    if (load) {
      for (const target of resolve(load[1], workScope))
        if (target.slot)
          addChange(
            line,
            [
              {
                kind: "load",
                dayId: target.day.lineageId,
                slotId: target.slot.lineageId,
                value: Number(load[2]),
                unit: load[3].toLowerCase() === "kg" ? "kg" : "lb",
              },
            ],
            `Update target load for ${label(target)}`,
          );
      continue;
    }
    question(
      `I could not resolve “${text}”. Specify the current day/exercise and the change you want; this instruction has not been applied.`,
    );
  }

  for (const prep of preparations.values()) {
    if (prep.invalid) continue;
    const notes = [...prep.notes];
    if (!prep.slot) for (const note of globalNotes) addNote(notes, note);
    if (!prep.items.length && !notes.length) continue;
    changes.push({
      reason: `Replace preparation for ${label(prep)}`,
      sourceQuote: prep.source.slice(0, 1000),
      operations: [
        {
          kind: "warmup",
          dayId: prep.day.lineageId,
          slotId: prep.slot?.lineageId ?? null,
          notes: notes.join("\n") || null,
          items: prep.items,
        },
      ],
    });
  }
  if (
    globalNotes.length &&
    ![...preparations.values()].some((prep) => prep.slot === null)
  ) {
    question(
      "General preparation guidance was supplied without a general warm-up section. Specify which day's preparation it should update.",
    );
  }
  if (!changes.length && !questions.length)
    question(
      "Describe the preparation steps or working prescription that should change, including its exercise or day.",
    );
  const result = programUpdateSchema.safeParse({ changes, questions });
  if (!result.success)
    return {
      changes: [],
      questions: [
        "The request exceeds the supported preparation or numeric limits. No changes were prepared; review the number of steps, repetitions, loads and rest durations.",
      ],
    };
  return result.data;
}
