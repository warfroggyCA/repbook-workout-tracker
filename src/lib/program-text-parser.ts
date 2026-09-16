import {
  programUpdateSchema,
  type ProgramTextUpdate,
} from "@/ai/tasks/program-update/schema";
import type { ProgramDocumentV3 } from "@/lib/program-document";
import {
  parseProgramTextUpdate as parsePreparation,
  type TextParserExercise,
} from "@/lib/program-preparation-text-parser";
import { parseWorkingTextUpdate } from "@/lib/program-working-text-parser";

export type { TextParserExercise } from "@/lib/program-preparation-text-parser";

/** Pure interpretation only. Unknown meaning is a blocking question, never consent. */
export function parseProgramTextUpdate(
  document: ProgramDocumentV3,
  input: string,
  library: ReadonlyArray<TextParserExercise>,
  activeDayId: string | null = null,
): ProgramTextUpdate {
  if (
    !input.trim() ||
    input.length > 20000 ||
    /[\u0000\u202a-\u202e\u2066-\u2069]/u.test(input)
  )
    return {
      changes: [],
      questions: [
        "Use 1–20,000 characters without hidden direction or null characters. Nothing was interpreted.",
      ],
    };
  const preparation =
    /(?:^|\n)\s*(?:[•*\-]\s+|#{1,6}\s*)?(?:(?:immediately\s+)?before\s+[^\n]+:|(?:general|start of (?:each|every) day).*warm[ -]?up|start of (?:each|every) day|warm[ -]?up update|update warm[ -]?up only)/i.test(
      input,
    );
  const result = preparation
    ? parsePreparation(document, input, library, activeDayId)
    : parseWorkingTextUpdate(document, input, library, activeDayId);
  if (
    preparation &&
    (result.changes.some((change) =>
      change.operations.some((operation) => operation.kind !== "warmup"),
    ) ||
      /(?:^|\n)\s*(?:keep|clarify|change(?:\s*\/\s*clarify)?)\s*:/i.test(input))
  ) {
    result.questions = [
      "This request mixes preparation blocks with working changes or preservation sections. Compare them separately so preparation context cannot reinterpret a working instruction.",
      ...result.questions,
    ].slice(0, 20);
  }
  const checked = programUpdateSchema.safeParse(result);
  if (!checked.success)
    return {
      changes: [],
      questions: [
        "This request exceeds the supported size or prescription limits. Split it into smaller requests; nothing has changed.",
      ],
    };
  return checked.data;
}
