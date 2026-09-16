import { readLines } from "@/lib/program-preparation-text-parser";

export const PROGRAM_EDIT_MAX_CLARIFICATIONS = 200;

export type EditInstruction = {
  key: string;
  source: string;
  text: string;
  scope: { day: string | null; exercise: string | null };
  intent:
    | "preserve"
    | "notes"
    | "replace"
    | "command"
    | "constraint"
    | "information";
  noteMode?: "replace" | "append" | "modify";
  allDaysNote?: boolean;
  otherExercisesExcept?: string[];
};
export type InterpretedProgramEdit = {
  instructions: EditInstruction[];
  constraints: {
    kind: "progression" | "groups" | "loads" | "history";
    day: string | null;
    source: string;
  }[];
};

export const coachingLanguage = (text: string) =>
  /\b(?:RIR|RPE|(?:reps?|repetitions?) in reserve|technique|form|failure|safeties|spotter|back support|both hands|bar close|range of motion|controlled|painful|swinging|actual effort)\b/i.test(
    text,
  ) || /^record the load as the weight of (?:the |a )?single dumbbell$/i.test(text);
export const embeddedProgramCommand = (text: string) =>
  /\b(?:increase|decrease|reduce|remove|replace|move|add|change|update)\b.{0,60}\b(?:sets?|reps?|weight|load|rest|progression|superset|exercise)\b/i.test(
    text,
  );
export const executableCondition = (text: string) =>
  /\b(?:if|when|unless|until|after|every|automatically)\b.*\b(?:increase|decrease|reduce|add|remove|replace|progress|deload|weight|load)\b|\b(?:increase|decrease|reduce|add|remove|replace|progress|deload)\b.*\b(?:if|when|unless|until|every)\b/i.test(
    text,
  );

/** An identity for a source instruction, not an exercise ID or confidence probability. */
export function editInstructionKey(value: string): string {
  // Include the complete normalized source to avoid hash collisions/replaying a
  // previously applied relative edit when an unrelated sentence is corrected.
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Stage A knows language and scope only. It never looks up or mutates a Program. */
export function interpretProgramEdit(
  input: string,
  dayLabels: readonly string[] = [],
): InterpretedProgramEdit {
  const result: InterpretedProgramEdit = { instructions: [], constraints: [] };
  let day: string | null = null;
  let exercise: string | null = null;
  let keep = false;
  let pendingNotes: EditInstruction["noteMode"] | null = null;
  let pendingSource = "";
  let allDaysNotesOnly = false;
  let otherExercises = false;
  const dayExercises = new Set<string>();
  let otherExercisesExcept: string[] = [];
  const emit = (
    source: string,
    text: string,
    intent: EditInstruction["intent"],
    noteMode?: EditInstruction["noteMode"],
  ) => {
    result.instructions.push({
      key: editInstructionKey(
        `${day ?? "program"}|${exercise ?? "context"}|${intent}|${text}`,
      ),
      source,
      text,
      scope: { day, exercise },
      intent,
      ...(noteMode ? { noteMode } : {}),
      ...(allDaysNotesOnly && intent === "notes" ? { allDaysNote: true } : {}),
      ...(otherExercises && intent === "preserve" ? { otherExercisesExcept: [...otherExercisesExcept] } : {}),
    });
  };
  for (const line of readLines(input)) {
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line.text);
    const normalized = (numbered?.[1] ?? line.text).replace(/\*\*([^*]+)\*\*/g, "$1");
    // Numbered noun headings establish scope just like a colon heading. Do
    // not reinterpret a numbered command or numeric prescription as a name.
    if (numbered && /\p{L}{3}/u.test(normalized) && /^[\p{L}\p{N}][\p{L}\p{N}\s'’–—/().-]{0,159}:?$/u.test(normalized) &&
      !/^\d+(?:\.\d+)?\s*(?:sets?|reps?|seconds?|secs?|minutes?|mins?|kg|lbs?)\b/i.test(normalized) &&
      !/^(?:day|routine|all|keep|preserve|leave|replace|swap|remove|delete|clear|reset|add|append|move|reorder|increase|decrease|reduce|set|change|update|modify|use|perform|record|do|don't|never|avoid|stop|before|after|if|when|rest|sets?|reps?|notes?)\b/i.test(normalized)) {
      if (pendingNotes) emit(pendingSource, "The replacement note is missing", "command");
      exercise = normalized.replace(/:$/, "");
      dayExercises.add(exercise);
      pendingNotes = null;
      keep = false;
      allDaysNotesOnly = false;
      otherExercises = false;
      continue;
    }
    // A decimal point in a load or RPE is not a sentence boundary. Keep the
    // original line as provenance even when a paragraph contains several edits.
    // A quoted replacement is one authored note, including all its sentences.
    const sentences = (pendingNotes && /^[“"].+[”"]\s*$/s.test(normalized)) || /^(?:(?:replace|add|append|update|modify|change|set)\s+(?:the\s+)?notes?\s*(?:(?:with|to|so)\s*)?:?\s*|notes?:\s*)[“"].+[”"]\s*$/i.test(normalized)
      ? [normalized]
      : normalized.split(/(?<=[.!?])\s+(?=[A-Z“"])/u);
    for (const sentence of sentences) {
      let text = sentence.trim().replace(/[.;]$/, "");
      if (!text) continue;
      if (
        pendingNotes &&
        (text.endsWith(":") || /^(?:day|routine)\s+[a-z0-9]+\b/i.test(text))
      ) {
        emit(pendingSource, "The replacement note is missing", "command");
        pendingNotes = null;
      }
      const heading = /^(day|routine)\s+([a-z]|\d+)(?:\s*[—–:-].*)?$/i.exec(
        text,
      );
      if (heading) {
        dayExercises.clear();
        allDaysNotesOnly = false;
        otherExercises = false;
        day = text.replace(/:$/, "");
        exercise = null;
        keep = false;
        pendingNotes = null;
        if (
          /\b(?:first|then|before|after|replace|remove|add|increase|decrease)\b/i.test(
            text,
          ) &&
          !dayLabels.includes(text)
        )
          emit(line.source, text, "command");
        continue;
      }
      const namedDay = dayLabels.find(
        (label) => label.toLowerCase() === text.replace(/:$/, "").toLowerCase(),
      );
      if (namedDay) {
        dayExercises.clear();
        allDaysNotesOnly = false;
        otherExercises = false;
        day = namedDay;
        exercise = null;
        keep = false;
        pendingNotes = null;
        continue;
      }
      if (/^all days\b/i.test(text)) {
        dayExercises.clear();
        otherExercises = false;
        allDaysNotesOnly = /^all days\s*[—–:-]\s*notes only$/i.test(text);
        day = null;
        exercise = null;
        keep = false;
        continue;
      }
      if (/^all other day \d+ exercises$/i.test(text)) {
        exercise = null;
        keep = false;
        otherExercises = true;
        otherExercisesExcept = [...dayExercises];
        continue;
      }
      if (otherExercises && /^(?:keep|preserve) (?:the )?(?:current|existing) (?:exercises|set counts|rep ranges|load targets|rest times|exercise order|supersets)(?:(?:,\s*(?:and\s+)?|\s+and\s+)(?:exercises|set counts|rep ranges|load targets|rest times|exercise order|supersets))*(?: unless affected by the .+ replacement above)?$/i.test(text)) {
        emit(line.source, text, "preserve");
        continue;
      }
      if (allDaysNotesOnly) {
        if (/^the following are authored guidance only$/i.test(text)) {
          emit(line.source, text, "information");
        } else {
          // This section explicitly requests literal guidance, never policy or
          // executable rules. Keep the text in day notes for owner review.
          emit(line.source, text, "notes", "append");
        }
        continue;
      }
      if (
        /^(keep|preserve|change(?:\s*\/\s*clarify)?|clarify|keep\s*\/\s*clarify)\s*:?$/i.test(
          text,
        )
      ) {
        keep = /^(keep|preserve):?$/i.test(text);
        exercise = null;
        pendingNotes = null;
        continue;
      }
      const dayPrefix =
        /^on\s+((?:day|routine)\s+(?:\d+|[a-z]))\s*[,;:]?\s+(.+)$/i.exec(text);
      if (dayPrefix) {
        if (day?.toLowerCase() !== dayPrefix[1].toLowerCase()) dayExercises.clear();
        otherExercises = false;
        day = dayPrefix[1];
        exercise = null;
        keep = false;
        text = dayPrefix[2];
      }
      const exercisePrefix = /^(?:on|for)\s+(.+?),\s*(.+)$/i.exec(text);
      if (exercisePrefix) {
        otherExercises = false;
        const named = dayLabels.find(
          (label) =>
            label.toLowerCase() ===
              exercisePrefix[1].replace(/ day$/i, "").toLowerCase() ||
            label.toLowerCase() === exercisePrefix[1].toLowerCase(),
        );
        if (named) {
          day = named;
          exercise = null;
          keep = false;
        } else {
          exercise = exercisePrefix[1];
          dayExercises.add(exercise);
        }
        text = exercisePrefix[2];
      }
      const noteLead =
        /^(replace|add|append|update|modify|change|set)\s+(?:the\s+)?notes?\s*(?:(?:with|to)\s*)?:\s*$/i.exec(
          text,
        );
      if (noteLead) {
        pendingSource = line.source;
        pendingNotes = /^(add|append)$/i.test(noteLead[1])
          ? "append"
          : /^(replace|set)$/i.test(noteLead[1])
            ? "replace"
            : "modify";
        continue;
      }
      if (/^notes?:\s*$/i.test(text)) {
        pendingSource = line.source;
        pendingNotes = "append";
        continue;
      }
      if (pendingNotes) {
        emit(
          line.source,
          text.replace(/^[“"]|[”"]$/g, ""),
          "notes",
          pendingNotes,
        );
        pendingNotes = null;
        continue;
      }
      if (
        /^keep (?:the )?(?:[a-z]+|\d+)[ -]day rotation:?$/i.test(text) ||
        /^[A-D]\s*→(?:\s*(?:power walk|[A-D])\s*→)*\s*(?:power walk|[A-D])$/i.test(
          text,
        ) ||
        /^update exercise notes to match these edits$/i.test(text)
      ) {
        emit(line.source, text, "information");
        continue;
      }
      const labelled = /^([^:]+):\s*(.*)$/.exec(text);
      if (
        labelled &&
        !/^(?:replace|add|append|update|modify|change|set)\s+(?:the\s+)?notes?\b/i.test(
          labelled[1],
        ) &&
        !/^(?:notes?|sets?|reps?|rest|(?:suggested )?(?:starting )?prescription)$/i.test(
          labelled[1],
        )
      ) {
        otherExercises = false;
        exercise = labelled[1]
          .replace(/^keep\s+/i, "")
          .replace(/\s+(?:effort|notes)$/i, "");
        dayExercises.add(exercise);
        text = labelled[2];
        if (!text) continue;
      }
      // Only known preservation phrases are informational. A mixed command is
      // left intact for validation instead of silently swallowing its tail.
      if (
        /^(?:keep |preserve )?(?:everything else|all other(?: day \d+)? exercises|all other exercises and set counts|existing exercise selection and (?:working-set|set) counts|existing exercises, working-set counts and supersets|all existing exercises, sets, rep ranges, order and supersets)(?: (?:on day \d+|in .+?))?(?: (?:stays?|remain))? (?:the same|unchanged)(?: unless explicitly changed below)?$/i.test(
          text,
        ) ||
        /^(?:everything else(?: on day \d+)?|all other day \d+ exercises) (?:stays?|remain) unchanged$/i.test(
          text,
        )
      ) {
        emit(line.source, text, "information");
        continue;
      }
      if (/^(?:keep )?everything else (?:the same|unchanged)$/i.test(text)) {
        emit(line.source, text, "information");
        continue;
      }
      let constraint:
        | InterpretedProgramEdit["constraints"][number]["kind"]
        | null = null;
      if (
        /^(?:do not|don't) create (?:any )?(?:new )?supersets(?: from (?:outdated pairing|old or stale) notes)?$/i.test(
          text,
        )
      )
        constraint = "groups";
      if (
        /^(?:keep|preserve) (?:the )?(?:existing|current) progression rules(?:; do not add automatic load increases through this update)?$/i.test(
          text,
        )
      )
        constraint = "progression";
      if (
        /^(?:(?:this request does not approve|do not (?:apply|approve)) (?:the )?pending .+ load proposal|do not apply the pending load-change proposal through this request)$/i.test(
          text,
        )
      )
        constraint = "loads";
      if (
        /^(?:apply (?:these changes |this |to )?(?:to )?future (?:scheduled )?workouts only|preserve (?:all )?(?:completed workout |workout )?history)$/i.test(
          text,
        )
      )
        constraint = "history";
      if (constraint) {
        result.constraints.push({ kind: constraint, day, source: line.source });
        emit(line.source, text, "constraint");
        continue;
      }
      if (
        /^(?:update request|new .+ routine)\b/i.test(text) &&
        !executableCondition(text) &&
        !/\b(?:delete|remove|replace|increase|decrease|add|change|update)\b/i.test(
          text.replace(/^update request/i, ""),
        )
      ) {
        emit(line.source, text, "information");
        continue;
      }
      const replacement =
        /^(?:replace|swap)\s+(?!notes?\b)(.+?)\s+(?:with|for)\s+(.+)$/i.exec(
          text,
        );
      if (replacement) {
        otherExercises = false;
        exercise = replacement[1]
          .replace(
            /^(?:the\s+)?(?:(?:\d+|one|two|three|four)\s+sets?\s+of\s+)?/i,
            "",
          )
          .replace(/^(?:one|two|three|four|\d+)\s+(.+?)\s+sets?$/i, "$1");
        dayExercises.add(exercise);
        emit(line.source, text, "replace");
        continue;
      }
      if (/^notes?:\s*\S/i.test(text)) {
        emit(line.source, text.replace(/^notes?:\s*/i, "").replace(/^[“"]|[”"]$/g, ""), "notes", "append");
        continue;
      }
      const explicitNotes =
        /^(?:keep everything the same but\s+)?(replace|add|append|update|modify|change|set)\s+(?:the\s+)?notes?\s*(?:(?:with|to|so)\s*)?:?\s*(.+)$/i.exec(
          text,
        );
      if (explicitNotes) {
        emit(
          line.source,
          explicitNotes[2].replace(/^[“"]|[”"]$/g, ""),
          "notes",
          /^(add|append)$/i.test(explicitNotes[1])
            ? "append"
            : /^(replace|set)$/i.test(explicitNotes[1])
              ? "replace"
              : "modify",
        );
        continue;
      }
      if (/^change the RIR target from\b/i.test(text)) {
        emit(line.source, text, "notes", "modify");
        continue;
      }
      text = text.replace(
        /\b((?:final|last) set (?:go to|reach))\s+(9(?:[–-]9\.5)?|10)(?=\s+(?:if|with|provided)\b|$)/i,
        "$1 RPE $2",
      );
      if (
        coachingLanguage(text) &&
        !executableCondition(text) &&
        !/^(?:replace|remove|add|move|superset|group)\b/i.test(text)
      ) {
        emit(line.source, text, "notes", "modify");
        continue;
      }
      const namedPreserve = /^(?:keep|preserve)\s+(.+?)\s+at\s+(.+)$/i.exec(
        text,
      );
      if (namedPreserve) {
        exercise = namedPreserve[1];
        text = `Keep ${namedPreserve[2]}`;
      }
      if (/^(?:keep|preserve|leave)\b/i.test(text) || keep)
        emit(line.source, text, "preserve");
      else emit(line.source, text, "command");
    }
  }
  if (pendingNotes)
    emit(pendingSource, "The replacement note is missing", "command");
  return result;
}
