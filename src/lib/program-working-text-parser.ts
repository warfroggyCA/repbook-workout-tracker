import type {
  ProgramTextUpdate,
  ProgramUpdateOperation as Operation,
} from "@/ai/tasks/program-update/schema";
import type { ProgramDocumentV3 } from "@/lib/program-document";
import { normalizeExerciseText } from "@/services/exercise-map";
import {
  readLines,
  sameMovement,
  seconds,
  type TextParserExercise,
} from "@/lib/program-preparation-text-parser";
import { MAX_STORED_LOAD, normalizeStoredLoad } from "@/lib/units";

type Day = ProgramDocumentV3["days"][number];
type Slot = Day["exercises"][number];
type Target = { day: Day; slot: Slot };
type Line = { text: string; source: string };
type Change = ProgramTextUpdate["changes"][number];
type Dose = {
  sets?: number;
  min?: number;
  max?: number;
  rest?: number;
  load?: number;
  unit?: "lb" | "kg";
};
const clean = (value: string) => value.trim().replace(/[.;]$/, "").trim();
const numberWords: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};
const numeric = (value: string) =>
  value.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
    (word) => numberWords[word.toLowerCase()],
  );

/** Consume the entire prescription. A recognized prefix cannot hide a second command. */
function dose(value: string): Dose | null {
  let rest = numeric(clean(value)).replace(/\s+to\s+(?=\d)/gi, "–");
  const result: Dose = {};
  const combined =
    /^(\d+)\s*(?:[x×]|(?:working\s+)?sets?\s+(?:of\s+)?)\s*(\d+)(?:\s*[–—-]\s*(\d+))?\s*(?:reps?|repetitions?)?\b/i.exec(
      rest,
    );
  if (combined) {
    result.sets = Number(combined[1]);
    result.min = Number(combined[2]);
    result.max = Number(combined[3] ?? combined[2]);
    rest = rest.slice(combined[0].length);
  } else {
    const single =
      /^(\d+)(?:\s*[–—-]\s*(\d+))?\s*(sets?|reps?|repetitions?)\b/i.exec(rest);
    if (single) {
      if (/^set/i.test(single[3])) {
        if (single[2]) return null;
        result.sets = Number(single[1]);
      } else {
        result.min = Number(single[1]);
        result.max = Number(single[2] ?? single[1]);
      }
      rest = rest.slice(single[0].length);
    }
  }
  // Exact load and exact rest may follow in either order. No rounding or unit inference.
  for (let index = 0; index < 3 && rest.trim(); index++) {
    rest = rest.replace(/^\s*(?:[,;]|\band\b|\bwith\b|\bat\b)\s*/i, "").trim();
    const load = /^(\d+(?:\.\d+)?)\s*(lb|lbs|pounds?|kg|kilograms?)\b/i.exec(
      rest,
    );
    if (load) {
      if (result.load !== undefined) return null;
      result.load = Number(load[1]);
      result.unit = /^(?:k)/i.test(load[2]) ? "kg" : "lb";
      rest = rest.slice(load[0].length);
      continue;
    }
    const time =
      /^(?:rest\s+)?((?:\d+(?:\.\d+)?\s*(?:minutes?|mins?|m|seconds?|secs?|s)\b\s*(?:and\s+)?)+)(?:rest\b)?/i.exec(
        rest,
      );
    if (time) {
      if (result.rest !== undefined) return null;
      const duration = seconds(time[1].trim());
      if (duration === null) return null;
      result.rest = duration;
      rest = rest.slice(time[0].length);
      continue;
    }
    return null;
  }
  if (
    rest.trim() ||
    !Object.keys(result).length ||
    (result.sets !== undefined && (result.sets < 1 || result.sets > 20)) ||
    (result.min !== undefined &&
      (result.min < 1 || result.max! < result.min || result.max! > 100)) ||
    (result.load !== undefined &&
      (result.load > MAX_STORED_LOAD ||
        normalizeStoredLoad(result.load) !== result.load))
  )
    return null;
  return result;
}

/** Exact catalog names and aliases; equipment may be omitted only for a unique current slot. */
export function resolveProgramTextDay(
  document: ProgramDocumentV3,
  reference: string,
  activeDayId: string | null,
): Day[] {
  const name = clean(reference).replace(/:$/, "");
  const normalized = normalizeExerciseText(name);
  const exact = document.days.filter(
    (day) => normalizeExerciseText(day.name) === normalized,
  );
  if (exact.length) return exact;
  if (/^(?:this|current)(?: day)?$/i.test(normalized))
    return document.days.filter((day) => day.lineageId === activeDayId);
  const qualified = document.days.filter(
    (day) =>
      normalizeExerciseText(day.name) ===
      normalizeExerciseText(name.replace(/\s+day$/i, "")),
  );
  if (qualified.length) return qualified;
  const marker = /^(?:(?:day|routine)\s+)?([a-z]|\d+)(?:\s*[—–:-].*)?$/i.exec(
    name,
  );
  if (!marker) return [];
  const named = document.days.filter((day) =>
    new RegExp(`^(?:day|routine)\\s+${marker[1]}(?:\\b|\\s)`, "i").test(
      day.name,
    ),
  );
  if (named.length) return named;
  const index = /^\d+$/.test(marker[1])
    ? Number(marker[1]) - 1
    : marker[1].toUpperCase().charCodeAt(0) - 65;
  return document.days[index] ? [document.days[index]] : [];
}

export function parseWorkingTextUpdate(
  document: ProgramDocumentV3,
  input: string,
  library: ReadonlyArray<TextParserExercise>,
  activeDayId: string | null,
): ProgramTextUpdate {
  const questions: string[] = [];
  const changes: Change[] = [];
  const catalog = new Map(library.map((item) => [item.id, item]));
  const edits = new Map<
    string,
    {
      target: Target;
      change: Change;
      fields: Map<string, string>;
      notes: string[];
      noteMode: "append" | "replace" | null;
    }
  >();
  const assertions: Array<{
    target: Target;
    field: string;
    expected?: unknown;
    source: string;
  }> = [];
  const protectedKinds: Array<{
    days: string[];
    kinds: Operation["kind"][];
    source: string;
  }> = [];
  const dayNotes = new Map<
    string,
    { day: Day; source: string; notes: string[] }
  >();
  let scope = document.days;
  let section:
    | "keep"
    | "change"
    | "clarify"
    | "notes"
    | "global"
    | "day-notes" = "change";
  let context: Target | null = null;
  let questionCount = 0;
  const ask = (message: string) => {
    const bounded = message.slice(0, 500);
    if (questions.includes(bounded)) return;
    questionCount++;
    if (questions.length < 20) questions.push(bounded);
    else
      questions[19] =
        "There are more unresolved instructions. Resolve the listed issues or split this request, then compare again. The entire request remains blocked.";
  };
  const label = (target: Target) =>
    `${target.day.name} · ${catalog.get(target.slot.exerciseId)?.name ?? "Exercise"}`;
  const key = (target: Target) =>
    `${target.day.lineageId}:${target.slot.lineageId}`;
  const matches = (reference: string, days = scope) =>
    days.flatMap((day) =>
      day.exercises
        .filter((slot) => {
          const pending = edits
            .get(`${day.lineageId}:${slot.lineageId}`)
            ?.change.operations.find((op) => op.kind === "replace");
          const exercise = catalog.get(
            pending?.kind === "replace" ? pending.exerciseId : slot.exerciseId,
          );
          return (
            exercise &&
            [exercise.name, ...(exercise.aliases ?? [])].some((name) =>
              sameMovement(clean(reference), name),
            )
          );
        })
        .map((slot) => ({ day, slot })),
    );
  const resolve = (reference: string, days = scope): Target | null => {
    const found = matches(reference, days);
    if (found.length === 1) return found[0];
    ask(
      found.length
        ? `“${reference}” matches more than one exercise: ${found.map(label).join("; ")}. Name its day and exact variant.`
        : `“${reference}” does not identify a current exercise in this scope. Name its day and exact exercise; no similar movement will be substituted.`,
    );
    return null;
  };
  const resolveCatalog = (reference: string): TextParserExercise | null => {
    const name = normalizeExerciseText(clean(reference));
    const found = library.filter((item) =>
      [item.name, ...(item.aliases ?? [])].some(
        (candidate) => normalizeExerciseText(candidate) === name,
      ),
    );
    if (found.length !== 1) {
      ask(
        `“${reference}” needs one exact available library exercise${found.length > 1 ? "; this alias is shared by multiple variants" : ""}. Choose its full library name.`,
      );
      return null;
    }
    if (!found[0].available) {
      ask(
        `“${reference}” is unavailable for the configured equipment. Resolve the equipment or choose an available exercise.`,
      );
      return null;
    }
    if (
      !["weight_reps", "reps", "assisted_reps"].includes(found[0].metricType)
    ) {
      ask(
        `“${reference}” needs an explicit timed or distance prescription in the editor.`,
      );
      return null;
    }
    return found[0];
  };
  const edit = (target: Target, line: Line) => {
    let entry = edits.get(key(target));
    if (!entry) {
      const change: Change = {
        reason: `Update ${label(target)}`,
        sourceQuote: line.source.slice(0, 1000),
        operations: [],
      };
      entry = { target, change, fields: new Map(), notes: [], noteMode: null };
      edits.set(key(target), entry);
      changes.push(change);
    }
    return entry;
  };
  const put = (target: Target, line: Line, operation: Operation) => {
    const entry = edit(target, line);
    const field = "field" in operation ? operation.field : operation.kind;
    const encoded = JSON.stringify(operation);
    const prior = entry.fields.get(field);
    if (prior && prior !== encoded) {
      const priorOp = entry.change.operations.find(
        (op) => ("field" in op ? op.field : op.kind) === field,
      );
      if (
        field === "load" &&
        priorOp?.kind === "load" &&
        priorOp.value === null &&
        entry.fields.has("replace")
      ) {
        entry.change.operations = entry.change.operations.filter(
          (op) => op !== priorOp,
        );
        entry.fields.delete(field);
      } else {
        ask(
          `Conflicting ${field} instructions for ${label(target)}. Keep one explicit intended value; neither instruction overrides the other.`,
        );
        return;
      }
    }
    if (!entry.fields.has(field)) {
      entry.fields.set(field, encoded);
      entry.change.operations.push(operation);
    }
  };
  const base = (target: Target) => ({
    dayId: target.day.lineageId,
    slotId: target.slot.lineageId,
  });
  const addDose = (
    target: Target,
    line: Line,
    values: Dose,
    preserve = false,
  ) => {
    if (target.slot.timedPrescription) {
      ask(
        `${label(target)} is timed work. Use the editor for its duration and metric; a repetitions instruction cannot change its meaning.`,
      );
      return;
    }
    if (preserve) {
      const pairs: Array<[string, unknown, unknown]> = [];
      if (values.sets !== undefined)
        pairs.push(["sets", target.slot.sets, values.sets]);
      if (values.min !== undefined)
        pairs.push([
          "reps",
          [target.slot.repMin, target.slot.repMax],
          [values.min, values.max],
        ]);
      if (values.rest !== undefined)
        pairs.push(["restSec", target.slot.restSec, values.rest]);
      if (values.load !== undefined)
        pairs.push([
          "load",
          [target.slot.targetLoad, target.slot.targetLoadUnit],
          [values.load, values.unit],
        ]);
      for (const [field, actual, expected] of pairs) {
        assertions.push({ target, field, expected, source: line.text });
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          ask(
            `KEEP does not match ${label(target)}: saved ${field} is ${JSON.stringify(actual)}, but your text says ${JSON.stringify(expected)}. Confirm whether to preserve the saved value or change it.`,
          );
      }
      return;
    }
    if (
      target.slot.supersetKey &&
      ((values.sets !== undefined && values.sets !== target.slot.sets) ||
        values.rest !== undefined)
    ) {
      ask(
        `${label(target)} belongs to a superset. Specify the group's rounds/rest in the editor; changing one member must not silently change the others.`,
      );
      return;
    }
    if (values.sets !== undefined)
      put(target, line, {
        ...base(target),
        kind: "slot_number",
        field: "sets",
        value: values.sets,
      });
    if (values.min !== undefined)
      put(target, line, {
        ...base(target),
        kind: "reps",
        min: values.min,
        max: values.max!,
      });
    if (values.rest !== undefined)
      put(target, line, {
        ...base(target),
        kind: "slot_number",
        field: "restSec",
        value: values.rest,
      });
    if (values.load !== undefined)
      put(target, line, {
        ...base(target),
        kind: "load",
        value: values.load,
        unit: values.unit!,
      });
  };
  const addNotes = (
    target: Target,
    line: Line,
    note: string,
    mode: "append" | "replace" = "append",
  ) => {
    // Notes are authored guidance only, never executable progression or scheduling rules.
    if (
      /\b(?:(?:most recent|previous|last)\s+(?:logged|working|workout)|round\s+(?:up|down|to)|(?:lightest|heaviest)\s+owned|except\b.*\b(?:weeks?|days?|kg|lb|pounds?|kilograms?))\b/i.test(
        note,
      )
    ) {
      ask(
        `“${note}” needs history, equipment calculations, or an exception decision. Give ${label(target)} an explicit target, or keep that guidance in the manual notes editor.`,
      );
      return;
    }
    if (
      /^[-+−]?\d|^(?:NaN|Infinity)\b/i.test(numeric(note)) ||
      /(?:^|[.;]\s+)(?:replace|remove|add|move|reorder|group|ungroup|increase|decrease|reduce|set|change|update)\b/i.test(
        note,
      ) ||
      /\b(?:unchanged|do not (?:set|change|replace|remove|add|move|increase|decrease)|automatically|every\s+(?:week|workout)|when\s+.+\bincrease)\b/i.test(
        note,
      )
    ) {
      ask(
        `Separate the Program command from the notes for ${label(target)}: “${note}”. Notes cannot execute rules or structural changes.`,
      );
      return;
    }
    const entry = edit(target, line);
    if (entry.noteMode && entry.noteMode !== mode) {
      ask(
        `Both append and replace notes were requested for ${label(target)}. Choose one mode.`,
      );
      return;
    }
    entry.noteMode = mode;
    if (!entry.notes.includes(note)) entry.notes.push(note);
  };
  const protect = (kinds: Operation["kind"][], line: Line) =>
    protectedKinds.push({
      days: scope.map((day) => day.lineageId),
      kinds,
      source: line.text,
    });
  const preserveGeneral = (text: string, line: Line): boolean => {
    if (
      /^(?:keep|leave|preserve)\s+(?:everything|every unmentioned day and exercise|all (?:other|unmentioned) (?:work|exercises|days)(?: and (?:set counts|sets))?|everything else)\s+unchanged$/i.test(
        text,
      )
    )
      return true;
    if (
      /^(?:keep\s+)?(?:all\s+)?existing (?:exercise selection and (?:working-set|set) counts|exercises, working-set counts and supersets|exercises, sets, rep ranges, order and supersets|exercises and set counts)(?: (?:remain )?unchanged)?(?: unless explicitly changed below)?$/i.test(
        text,
      ) ||
      /^(?:keep\s+)?(?:working exercises, working sets, progression rules and working-set supersets|all other exercises and set counts)(?: (?:remain )?unchanged)?$/i.test(
        text,
      )
    ) {
      if (!/unless explicitly changed/i.test(text) && section === "keep")
        protect(
          [
            "add",
            "remove",
            "replace",
            "reorder",
            "group",
            "ungroup",
            "slot_number",
            "reps",
          ],
          line,
        );
      return true;
    }
    if (
      /^(?:keep (?:all )?existing progression rules|do not add automatic load increases through this update)(?:; do not add automatic load increases through this update)?$/i.test(
        text,
      )
    ) {
      // This constrains progression-rule edits; explicit target loads remain distinct.
      for (const day of scope)
        for (const slot of day.exercises)
          assertions.push({
            target: { day, slot },
            field: "progressionRuleId",
            source: line.text,
          });
      return true;
    }
    if (/^no additional exercises or sets(?: in this update)?$/i.test(text)) {
      protect(["add", "slot_number"], line);
      return true;
    }
    if (
      /^do not create new supersets(?: from outdated pairing notes)?$/i.test(
        text,
      )
    ) {
      protect(["group"], line);
      return true;
    }
    return false;
  };

  for (const raw of readLines(input)) {
    const line = {
      ...raw,
      text: clean(
        raw.text.replace(/^\d+[.)]\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1"),
      ),
    };
    let text = line.text;
    if (!text) continue;
    const heading = /^(?:day|routine)\s+([a-z]|\d+)\b(?:\s*[—–:-].*)?$/i.exec(
      text,
    );
    if (heading) {
      scope = resolveProgramTextDay(document, text, activeDayId);
      context = null;
      section = "change";
      // A contradictory day number / routine letter is not a harmless label.
      const other = /\broutine\s+([a-z])\b/i.exec(text);
      if (
        scope.length !== 1 ||
        (other &&
          resolveProgramTextDay(document, `Routine ${other[1]}`, activeDayId)[0]
            ?.lineageId !== scope[0]?.lineageId)
      ) {
        ask(
          `Which saved day is “${text}”? Its day markers are missing, ambiguous, or contradictory.`,
        );
        scope = [];
      }
      if (
        /\b(?:first|then|before|after|replace|remove|add|increase|decrease)\b/i.test(
          text,
        ) &&
        !document.days.some((day) => day.name === text)
      )
        ask(
          `The day heading may contain a change: “${text}”. State the order or exercise edit as a separate instruction.`,
        );
      continue;
    }
    const namedDay = text.endsWith(":")
      ? document.days.filter(
          (day) =>
            normalizeExerciseText(day.name) ===
            normalizeExerciseText(text.slice(0, -1)),
        )
      : [];
    if (namedDay.length) {
      context = null;
      section = "change";
      scope = namedDay;
      if (
        namedDay.length !== 1 ||
        matches(text.slice(0, -1), document.days).length
      ) {
        ask(
          `“${text}” is an ambiguous day or exercise heading. Use an explicit day number.`,
        );
        scope = [];
      }
      continue;
    }
    if (/^all days(?:\s*[—–:-].*)?$/i.test(text)) {
      scope = document.days;
      context = null;
      section = /^all days\s*[—–:-]\s*(?:day )?notes:?$/i.test(text)
        ? "day-notes"
        : "global";
      continue;
    }
    if (/^day notes:?$/i.test(text)) {
      context = null;
      if (scope.length !== 1) {
        ask(
          "Name one day, or use All days — Notes, before supplying day guidance.",
        );
        scope = [];
      }
      section = "day-notes";
      continue;
    }
    if (
      /^(?:keep|change(?:\s*\/\s*clarify)?|clarify|keep\s*\/\s*clarify|notes|exercise notes)\s*:?$/i.test(
        text,
      )
    ) {
      section = /^keep$/i.test(text.replace(/:$/, ""))
        ? "keep"
        : /^change/i.test(text)
          ? "change"
          : /notes/i.test(text)
            ? "notes"
            : "clarify";
      context = null;
      continue;
    }
    if (section === "day-notes") {
      if (
        /^(?:set|change|update|replace|remove|add|move|reorder|group|ungroup)\b/i.test(
          text,
        )
      ) {
        ask(
          `A command appears inside day notes: “${text}”. Put it in a CHANGE section or clarify that it is guidance only.`,
        );
        continue;
      }
      for (const day of scope) {
        const entry = dayNotes.get(day.lineageId) ?? {
          day,
          source: line.source,
          notes: [],
        };
        if (!entry.notes.includes(text)) entry.notes.push(text);
        dayNotes.set(day.lineageId, entry);
      }
      continue;
    }
    if (/^update request\s*[—–:-]\s*[^.;]+$/i.test(text)) {
      if (/\b(?:replace|remove|add|move|increase|decrease)\b/i.test(text))
        ask(
          `State the change in the request title as a separate instruction: “${text}”.`,
        );
      continue;
    }
    if (
      /^(?:apply to future (?:scheduled )?workouts only\.\s*)?preserve completed workout history$/i.test(
        text,
      ) ||
      /^apply to future (?:scheduled )?workouts only$/i.test(text)
    )
      continue;
    if (
      /^update exercise notes to match these edits\.\s*do not create new supersets from outdated pairing notes$/i.test(
        text,
      )
    ) {
      protect(["group"], line);
      continue;
    }
    if (preserveGeneral(text, line)) {
      context = null;
      continue;
    }
    if (/\b(?:rotation|schedule|power walk)\b|→/i.test(text)) {
      ask(
        `The calendar/rotation cannot be verified or changed by this Program-draft parser: “${text}”. Keep scheduling instructions outside this request and check Schedule separately.`,
      );
      context = null;
      continue;
    }
    if (
      /\b(?:completed|historical|active workout|yesterday|last workout)\b/i.test(
        text,
      )
    ) {
      ask(
        `This editor changes future Program intent only. Clarify this instruction without changing performed or active workout records: “${text}”.`,
      );
      context = null;
      continue;
    }
    if (
      /\b(?:if|unless|maybe|perhaps|pending|proposed|if adopted|optionally)\b/i.test(
        text,
      ) &&
      !/^this request does not approve\b/i.test(text)
    ) {
      ask(
        `A decision is needed before interpreting “${text}”. State the change unconditionally, or remove it from this request.`,
      );
      context = null;
      continue;
    }
    if (/^this request does not approve\b.*\bload proposal$/i.test(text)) {
      if (context)
        assertions.push({ target: context, field: "load", source: line.text });
      else
        ask(
          `Name the exact exercise whose load must stay unchanged: “${text}”.`,
        );
      continue;
    }
    let workScope = scope;
    const onDay = /^on\s+(.+?)\s*[,;:]\s*(.+)$/i.exec(text);
    if (onDay) {
      workScope = resolveProgramTextDay(document, onDay[1], activeDayId);
      text = onDay[2];
      context = null;
      if (workScope.length !== 1) {
        ask(`Which Program day is “${onDay[1]}”?`);
        continue;
      }
    }
    // Only remove a fully understood preservation sentence; never discard arbitrary trailing text.
    const trailing = /^(.*?)\.\s*((?:keep|leave)\s+.+)$/i.exec(text);
    if (
      trailing &&
      /^(?:leave|keep) (?:everything else|every unmentioned day and exercise|all other exercises and set counts) unchanged$/i.test(
        clean(trailing[2]),
      )
    )
      text = trailing[1];

    const replacement =
      /^(?:replace|swap)\s+(?!notes?\b)(?:the\s+)?(?:(\d+)\s+sets?\s+of\s+)?(.+?)\s+(?:with|for)\s+(?:(\d+)\s+sets?\s+of\s+)?(.+?)(?:,?\s+in the same (?:exercise )?slot)?$/i.exec(
        text,
      );
    if (replacement) {
      context = null;
      const target = resolve(replacement[2], workScope),
        exercise = resolveCatalog(replacement[4]);
      if (!target || !exercise) continue;
      if (
        target.slot.timedPrescription ||
        !["weight_reps", "reps", "assisted_reps"].includes(
          catalog.get(target.slot.exerciseId)?.metricType ?? "unknown",
        )
      ) {
        ask(
          `${label(target)} needs an explicit metric conversion in the editor before replacement.`,
        );
        continue;
      }
      if (replacement[1] && Number(replacement[1]) !== target.slot.sets) {
        ask(
          `Replacement says ${replacement[1]} existing sets for ${label(target)}, but the saved prescription has ${target.slot.sets}. Clarify the starting exercise and set count.`,
        );
        continue;
      }
      if (exercise.id === target.slot.exerciseId) {
        ask(
          `${label(target)} is already that exercise. State the target or note change instead.`,
        );
        continue;
      }
      put(target, line, {
        ...base(target),
        kind: "replace",
        exerciseId: exercise.id,
      });
      // A new movement cannot inherit the previous movement's load evidence.
      put(target, line, {
        ...base(target),
        kind: "load",
        value: null,
        unit: null,
      });
      if (replacement[3])
        addDose(target, line, { sets: Number(replacement[3]) });
      context = target;
      continue;
    }

    const noteCommand =
      /^(append|add|replace|set|update|clear)\s+(?:the\s+)?notes?\s+(?:for|on)\s+(.+?)(?:\s*(?::|\bto\b|\bwith\b)\s*(.+))?$/i.exec(
        text,
      );
    if (noteCommand) {
      context = resolve(noteCommand[2], workScope);
      if (!context) continue;
      const mode = /^(?:append|add)$/i.test(noteCommand[1])
        ? "append"
        : "replace";
      if (/^clear$/i.test(noteCommand[1]) && !noteCommand[3]) {
        const entry = edit(context, line);
        entry.noteMode = "replace";
        entry.notes = [];
      } else if (noteCommand[3]) addNotes(context, line, noteCommand[3], mode);
      else ask(`Provide the note text for ${label(context)} after a colon.`);
      continue;
    }
    const prescription =
      /^(?:change|set|update)\s+(.+?)(?:\s+(?:working\s+)?(?:weight|load|prescription))?\s+to\s+(.+)$/i.exec(
        text,
      );
    if (
      prescription &&
      !/^(?:set|change)\s+(?:the\s+)?progression\b/i.test(text)
    ) {
      context = resolve(prescription[1], workScope);
      if (!context) continue;
      const values = dose(prescription[2]);
      if (!values)
        ask(
          `Clarify the complete prescription for ${label(context)}: “${prescription[2]}”. Use 1–20 sets, ordered 1–100 reps, an exact rest up to 30 minutes, and an explicit lb/kg load.`,
        );
      else addDose(context, line, values);
      continue;
    }
    const relative =
      /^(increase|decrease|reduce)\s+(.+?)\s+(?:load|weight)\s+by\s+(\d+(?:\.\d+)?)\s*(lb|lbs|kg)$/i.exec(
        text,
      );
    if (relative) {
      context = resolve(relative[2], workScope);
      if (!context) continue;
      const unit = relative[4].toLowerCase() === "kg" ? "kg" : "lb";
      if (
        context.slot.targetLoad == null ||
        context.slot.targetLoadUnit !== unit
      ) {
        ask(
          `${label(context)} has no saved target load in ${unit}. Give an absolute load and unit; recent workout loads are not assumed.`,
        );
        continue;
      }
      const value = Number(
        (
          context.slot.targetLoad +
          (/^increase$/i.test(relative[1]) ? 1 : -1) * Number(relative[3])
        ).toFixed(8),
      );
      if (
        value < 0 ||
        value > MAX_STORED_LOAD ||
        normalizeStoredLoad(value) !== value
      )
        ask(
          `The requested load for ${label(context)} is outside the supported bounds or needs more than two decimal places. Give an exact supported load; it will not be silently rounded.`,
        );
      else addDose(context, line, { load: value, unit });
      continue;
    }
    const remove =
      /^(?:remove|delete)\s+(.+?)(?:\s+from (?:this|the) (?:day|routine))?$/i.exec(
        text,
      );
    if (remove) {
      context = resolve(remove[1], workScope);
      if (!context) continue;
      if (context.slot.supersetKey || context.day.exercises.length <= 1) {
        ask(
          `Removing ${label(context)} changes a group or leaves an empty day. Resolve that structure in the editor first.`,
        );
        continue;
      }
      put(context, line, { ...base(context), kind: "remove" });
      context = null;
      continue;
    }
    const progression =
      /^(?:set|change)\s+(?:the\s+)?progression(?: rule)?\s+for\s+(.+?)\s+to\s+(manual|hold|double[ _-]progression)$/i.exec(
        text,
      );
    if (progression) {
      context = resolve(progression[1], workScope);
      if (context)
        put(context, line, {
          ...base(context),
          kind: "slot_text",
          field: "progressionRuleId",
          value: progression[2].toLowerCase().replace(/[ -]/g, "_"),
        });
      continue;
    }
    const move =
      /^move\s+(.+?)\s+(?:(?:to\s+)?(first|last)|(?:immediately\s+)?(before|after)\s+(.+))$/i.exec(
        text,
      );
    if (move) {
      context = null;
      const target = resolve(move[1], workScope);
      if (!target) continue;
      const relativeTo = move[4] ? resolve(move[4], [target.day]) : null;
      if (move[4] && !relativeTo) continue;
      if (target.slot.supersetKey || relativeTo?.slot.supersetKey) {
        ask(
          `Move the entire superset in the editor; “${text}” must not split or reorder its members implicitly.`,
        );
        continue;
      }
      if (relativeTo?.slot.lineageId === target.slot.lineageId) {
        ask("An exercise cannot be moved before or after itself.");
        continue;
      }
      const ids = target.day.exercises
        .map((slot) => slot.lineageId)
        .filter((id) => id !== target.slot.lineageId);
      const position = move[2]
        ? /^first$/i.test(move[2])
          ? 0
          : ids.length
        : ids.indexOf(relativeTo!.slot.lineageId) +
          (/^after$/i.test(move[3]) ? 1 : 0);
      ids.splice(position, 0, target.slot.lineageId);
      changes.push({
        reason: `Reorder ${target.day.name}`,
        sourceQuote: line.source.slice(0, 1000),
        operations: [
          { kind: "reorder", dayId: target.day.lineageId, slotIds: ids },
        ],
      });
      continue;
    }
    const add =
      /^add\s+(.+?)\s*:\s*(.+?)\s*;\s*(?:after\s+(.+)|(first|last))$/i.exec(
        text,
      );
    if (add) {
      context = null;
      if (workScope.length !== 1) {
        ask("Specify one day for the added exercise.");
        continue;
      }
      const exercise = resolveCatalog(add[1]),
        values = dose(add[2]);
      if (!exercise) continue;
      if (
        !values ||
        values.sets === undefined ||
        values.min === undefined ||
        values.rest === undefined
      ) {
        ask(
          `Adding “${add[1]}” needs complete sets, reps, rest, and an insertion point. Example: Add Exercise: 2 × 8–12; rest 90 seconds; last.`,
        );
        continue;
      }
      const day = workScope[0],
        after = add[3] ? resolve(add[3], [day]) : null;
      if (add[3] && !after) continue;
      if (after?.slot.supersetKey) {
        ask("Choose an insertion point outside the superset in the editor.");
        continue;
      }
      if (day.exercises.some((slot) => slot.exerciseId === exercise.id)) {
        ask(
          `“${exercise.name}” is already in ${day.name}. Clarify whether you want another distinct slot or to edit its existing prescription.`,
        );
        continue;
      }
      changes.push({
        reason: `Add ${exercise.name} to ${day.name}`,
        sourceQuote: line.source.slice(0, 1000),
        operations: [
          {
            kind: "add",
            dayId: day.lineageId,
            exerciseId: exercise.id,
            afterSlotId:
              after?.slot.lineageId ??
              (/^last$/i.test(add[4] ?? "")
                ? day.exercises.at(-1)!.lineageId
                : null),
            sets: values.sets,
            repMin: values.min,
            repMax: values.max!,
            restSec: values.rest,
            load: values.load ?? null,
            loadUnit: values.unit ?? null,
          },
        ],
      });
      continue;
    }
    const keepVariant =
      /^keep\s+(.+?)\s+as\s+(.+?)(?:\s*[—–-]\s*not\s+.+)?$/i.exec(text);
    if (keepVariant) {
      const target = resolve(keepVariant[1], workScope);
      if (target) {
        const exercise = catalog.get(target.slot.exerciseId)!;
        if (
          ![exercise.name, ...(exercise.aliases ?? [])].some(
            (name) =>
              normalizeExerciseText(name) ===
              normalizeExerciseText(keepVariant[2]),
          )
        )
          ask(
            `KEEP names two different variants for ${label(target)}. Clarify which exact movement to retain.`,
          );
        assertions.push({ target, field: "replace", source: line.text });
      }
      context = null;
      continue;
    }
    const labelled = /^(?:keep\s+)?(.+?)\s*:\s*(.*)$/i.exec(text);
    if (labelled) {
      const name = labelled[1].replace(/\s+(?:effort|notes|first)$/i, "");
      const found = matches(name, workScope);
      if (found.length === 1) {
        context = found[0];
        const preserve = section === "keep" || /^keep\s+/i.test(text);
        if (/\s+first$/i.test(labelled[1])) {
          assertions.push({
            target: context,
            field: "reorder",
            source: line.text,
          });
          if (context.day.exercises[0].lineageId !== context.slot.lineageId)
            ask(
              `${label(context)} is not first in the saved day. Confirm whether to keep the current order or move it.`,
            );
        }
        const values = dose(labelled[2]);
        if (values) addDose(context, line, values, preserve);
        else if (labelled[2] && !preserve) addNotes(context, line, labelled[2]);
        else if (labelled[2])
          ask(
            `Clarify the KEEP assertion for ${label(context)}: “${labelled[2]}”.`,
          );
        continue;
      }
      if (
        /^(?:suggested )?(?:starting )?prescription$/i.test(labelled[1]) &&
        context
      ) {
        const values = dose(labelled[2]);
        if (values) addDose(context, line, values);
        else
          ask(
            `Clarify the complete prescription for ${label(context)}: “${labelled[2]}”.`,
          );
        continue;
      }
      // A failed new heading must clear the prior target, including unknown exercise families.
      context = null;
      ask(
        `“${labelled[1]}” needs one exact exercise in its day. List the exercises explicitly if this instruction covers a family or several movements.`,
      );
      continue;
    }
    if (section === "keep") {
      const order = /^(.+?)\s+before\s+(.+)$/i.exec(text);
      if (order) {
        const first = resolve(order[1], workScope),
          second = resolve(order[2], workScope);
        if (first && second) {
          if (
            first.day.lineageId !== second.day.lineageId ||
            first.day.exercises.indexOf(first.slot) >=
              first.day.exercises.indexOf(second.slot)
          )
            ask(
              `KEEP order does not match the saved Program: “${text}”. Confirm whether the order should change.`,
            );
          assertions.push({
            target: first,
            field: "reorder",
            source: line.text,
          });
        }
        context = null;
        continue;
      }
      const keepLoad =
        /^(?:current\s+)?(.+?)\s+working load of\s+(\d+(?:\.\d+)?)\s*(lb|lbs|kg)(?:\s+for now)?$/i.exec(
          text,
        );
      if (keepLoad) {
        const target = resolve(keepLoad[1], workScope);
        if (target)
          addDose(
            target,
            line,
            {
              load: Number(keepLoad[2]),
              unit: keepLoad[3].toLowerCase() === "kg" ? "kg" : "lb",
            },
            true,
          );
        context = null;
        continue;
      }
    }
    const standalone = matches(text.replace(/:$/, ""), workScope);
    if (standalone.length === 1) {
      context = standalone[0];
      continue;
    }
    if (context && section !== "keep") {
      const values = dose(text);
      if (values) {
        addDose(context, line, values);
        continue;
      }
      // Only explicit guidance forms attach to a prior exercise; a bare pronoun after
      // an unresolved instruction cannot retarget that exercise accidentally.
      if (
        /^(?:use|record|start light|leave|aim|avoid|do not (?:aim|initially target|chase|grind|swing)|the final set|keep (?:the|your)|rest longer|stop if)\b/i.test(
          text,
        )
      ) {
        addNotes(context, line, text);
        continue;
      }
    }
    context = null;
    ask(
      `I could not resolve “${text}”. Name the day, exact exercise and requested change, or explicitly label authored guidance as exercise notes.`,
    );
  }

  for (const entry of edits.values()) {
    const replacement = entry.change.operations.some(
      (op) => op.kind === "replace",
    );
    if (entry.noteMode) {
      let existing =
        entry.noteMode === "append" && !replacement
          ? entry.target.slot.notes
          : null;
      if (
        existing &&
        entry.notes.some((note) =>
          /^(?:(?:leave|use|aim for|target|retain|keep)\s+)?(?:(?:approximately|about)\s+)?\d+(?:\.\d+)?(?:\s*[–—-]\s*\d+(?:\.\d+)?)?\s*(?:(?:technically sound\s+)?repetitions? in reserve|RIR|RPE)\b/i.test(
            note,
          ),
        )
      ) {
        // Replace a standalone target-effort sentence, retaining all technique
        // and safety sentences. Mixed clauses need an explicit owner rewrite.
        const sentences = existing.split(/(?<=[.!?])\s+(?=[A-Z])/u);
        const effort = /\b(?:RIR|RPE|repetitions? in reserve)\b/i;
        const simple =
          /^(?:use|aim for|target|leave|retain|keep)\s+(?:(?:approximately|about)\s+)?\d+(?:\.\d+)?(?:\s*[–—-]\s*\d+(?:\.\d+)?)?\s*(?:RIR|RPE|(?:technically sound\s+)?repetitions? in reserve)(?:\s+(?:during normal training|on (?:most|earlier|all) sets))?[.!]?$/i;
        if (
          sentences.some(
            (sentence) => effort.test(sentence) && !simple.test(sentence),
          )
        )
          ask(
            `Existing effort guidance for ${label(entry.target)} is mixed with other notes. Use “Replace notes for [exercise]: …” with the complete intended notes so contradictory targets are not appended.`,
          );
        else
          existing =
            sentences.filter((sentence) => !effort.test(sentence)).join(" ") ||
            null;
      }
      const newNotes = entry.notes.filter(
        (note) => !existing?.split("\n").includes(note),
      );
      const notes = [existing, ...newNotes].filter(Boolean).join("\n") || null;
      if ((notes?.length ?? 0) > 2000)
        ask(
          `Notes for ${label(entry.target)} would exceed 2,000 characters. Shorten them or explicitly replace the existing notes.`,
        );
      else
        put(
          entry.target,
          { text: "", source: entry.change.sourceQuote },
          {
            ...base(entry.target),
            kind: "slot_text",
            field: "notes",
            value: notes,
          },
        );
    }
    if (entry.fields.has("remove") && entry.change.operations.length > 1)
      ask(
        `The request both removes and edits ${label(entry.target)}. Choose one intent.`,
      );
  }
  for (const entry of dayNotes.values()) {
    const text = [
      entry.day.notes,
      ...entry.notes.filter(
        (note) => !entry.day.notes?.split("\n").includes(note),
      ),
    ]
      .filter(Boolean)
      .join("\n");
    if (text.length > 2000) {
      ask(
        `Day notes for ${entry.day.name} would exceed 2,000 characters. Shorten the guidance in the editor.`,
      );
      continue;
    }
    changes.push({
      reason: `Append day guidance for ${entry.day.name} (notes only)`,
      sourceQuote: entry.source.slice(0, 1000),
      operations: [
        {
          kind: "day_text",
          dayId: entry.day.lineageId,
          field: "notes",
          value: text,
        },
      ],
    });
  }
  const fieldFor = (op: Operation) => ("field" in op ? op.field : op.kind);
  for (const constraint of assertions) {
    const operations = changes
      .flatMap((change) => change.operations)
      .filter(
        (op) =>
          op.dayId === constraint.target.day.lineageId &&
          (("slotId" in op && op.slotId === constraint.target.slot.lineageId) ||
            (constraint.field === "reorder" && op.kind === "reorder")),
      );
    if (operations.some((op) => fieldFor(op) === constraint.field))
      ask(
        `A change conflicts with a KEEP constraint: “${constraint.source}”. Resolve the contradiction before applying any changes.`,
      );
  }
  const structural = new Map<string, number>();
  for (const change of changes)
    for (const op of change.operations) {
      for (const constraint of protectedKinds)
        if (
          constraint.days.includes(op.dayId) &&
          constraint.kinds.includes(op.kind)
        )
          ask(
            `A proposed change conflicts with “${constraint.source}”. State the exception explicitly or remove the change.`,
          );
      if (["add", "remove", "reorder"].includes(op.kind))
        structural.set(op.dayId, (structural.get(op.dayId) ?? 0) + 1);
    }
  for (const [dayId, count] of structural)
    if (count > 1)
      ask(
        `Several structural edits affect ${document.days.find((day) => day.lineageId === dayId)?.name}. Apply one structural change at a time so insertion and ordering references cannot become stale.`,
      );
  const replacements = changes
    .flatMap((change) => change.operations)
    .filter((op) => op.kind === "replace");
  for (const change of changes)
    for (const op of change.operations) {
      if (
        (op.kind === "reorder" &&
          replacements.some((replacement) => replacement.dayId === op.dayId)) ||
        (op.kind === "add" &&
          replacements.some(
            (replacement) =>
              replacement.dayId === op.dayId &&
              replacement.slotId === op.afterSlotId,
          ))
      )
        ask(
          "An ordering or insertion instruction depends on an exercise being replaced. Apply the replacement first, then compare the order change against its new identity.",
        );
    }
  // Keep previews valid even while blocked. Duplicate structure operations are
  // already a question; don't turn that recoverable ambiguity into a parse error.
  const previewFields = new Set<string>();
  const proposed = changes
    .map((change) => ({
      ...change,
      operations: change.operations.filter((op) => {
        const identity = `${op.dayId}:${"slotId" in op ? op.slotId : "day"}:${fieldFor(op)}`;
        if (previewFields.has(identity)) return false;
        previewFields.add(identity);
        return true;
      }),
    }))
    .filter((change) => change.operations.length);
  if (!proposed.length && !questionCount)
    ask(
      "The request contains only preserved values or context. No Program changes are needed; describe a specific edit if one was intended.",
    );
  return { changes: proposed, questions };
}
