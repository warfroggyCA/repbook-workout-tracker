export function extractExplicitWorkExerciseNames(text: string): string[] {
  const mainWorkout = /^MAIN WORKOUT:\s*$/im.exec(text);
  if (!mainWorkout) return [];

  const workSection = text.slice(mainWorkout.index + mainWorkout[0].length);
  const names: string[] = [];
  for (const line of workSection.split("\n")) {
    const match = /^\s*\d+[A-Z]?\.\s+(.+?)\s+[—–-]\s+\d/.exec(line);
    if (match?.[1]) names.push(match[1].trim());
  }
  return names;
}

export function exerciseNameSimilarity(
  requestedName: string,
  selectedName: string
): number {
  const tokens = (name: string) =>
    new Set(
      name
        .toLowerCase()
        .replaceAll("pressdown", "pushdown")
        .replaceAll("ez-bar", "ezbar")
        .match(/[a-z0-9]+/g) ?? []
    );
  const requested = tokens(requestedName);
  const selected = tokens(selectedName);
  if (requested.size === 0 || selected.size === 0) return 0;
  const overlap = [...requested].filter((token) => selected.has(token)).length;
  return overlap / Math.min(requested.size, selected.size);
}

export function splitRoutineBuildRequests(text: string): string[] {
  const explicitTitlePattern = /^ROUTINE TITLE:/gim;
  const explicitTitleMatches = [...text.matchAll(explicitTitlePattern)];
  const naturalDayPattern = /^(?:#{1,6}\s*)?(?:\*{1,2})?DAY\s+(?:\d+|[A-Z])(?:\s*[:\u2014\u2013-].*)?(?:\*{1,2})?\s*$/gim;
  const naturalDayMatches = [...text.matchAll(naturalDayPattern)];
  const titleMatches = explicitTitleMatches.length >= 2
    ? explicitTitleMatches
    : naturalDayMatches;
  if (titleMatches.length < 2 || titleMatches.length > 7) return [text];

  const globalMatch = /^GLOBAL PROGRESSION RULES:/im.exec(text);
  const contentEnd = globalMatch?.index ?? text.length;
  const starts = titleMatches
    .map((match) => match.index ?? 0)
    .filter((index) => index < contentEnd);
  if (starts.length < 2 || starts.length > 7) return [text];

  const globalRules = globalMatch ? text.slice(globalMatch.index).trim() : "";
  const sharedContext = text.slice(0, starts[0]).trim();
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? contentEnd;
    const day = text.slice(start, end).trim();
    const workExerciseNames = extractExplicitWorkExerciseNames(day);
    const preservationChecklist = workExerciseNames.length
      ? [
          `The MAIN WORKOUT contains exactly ${workExerciseNames.length} work exercises. Return exactly ${workExerciseNames.length} exercise objects, in this order:`,
          ...workExerciseNames.map((name, exerciseIndex) =>
            `${exerciseIndex + 1}. ${name}`
          ),
          "Do not turn section headings, general warm-ups, ramp-up headings, or prep-set headings into exercises. Do not omit an exercise when the exact library variant is unavailable: select the closest available exercise and clearly explain the substitution in notes.",
        ].join("\n")
      : "";
    const isNaturalUpdate = explicitTitleMatches.length < 2;
    return [
      isNaturalUpdate
        ? "This is one day from a larger update to the user's current Program. Return exactly one complete updated day. Apply every requested change for this day, resolve references such as 'current curl' and 'it' from currentProgram, and preserve every current exercise and prescription that the user did not ask to change. Preserve optional status and requested supersets or tri-sets."
        : "This is one day from a larger replacement Program. Return exactly one day. Preserve every warm-up, ramp-up set, work set, rest, rep range, group, cue, optional exercise, and progression note from this day.",
      sharedContext
        ? `Shared instructions for the complete replacement Program:\n${sharedContext}`
        : "",
      preservationChecklist,
      day,
      globalRules,
    ]
      .filter(Boolean)
      .join("\n\n");
  });
}

export type RoutineBuildProgramContext = {
  name: string;
  days: Array<{
    lineageId: string;
    name: string;
    exercises: Array<{
      exerciseId: string;
      name: string;
      sets: number;
      repMin: number;
      repMax: number;
      restSec: number;
      group: string | null;
    }>;
  }>;
};

export function routineBuildContextForRequest(
  request: string,
  currentProgram: RoutineBuildProgramContext,
  activeDayId: string | null,
): RoutineBuildProgramContext {
  const ordinalMatch = /(?:ROUTINE TITLE:\s*)?DAY\s+(\d+)/i.exec(request);
  const ordinal = ordinalMatch ? Number(ordinalMatch[1]) - 1 : -1;
  const matchedDay = ordinal >= 0
    ? currentProgram.days[ordinal]
    : currentProgram.days.find((day) => day.lineageId === activeDayId);

  return {
    name: currentProgram.name,
    days: matchedDay ? [matchedDay] : currentProgram.days,
  };
}
