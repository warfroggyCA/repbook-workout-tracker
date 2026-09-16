import {
  normalizeExerciseText,
  extractExerciseIdentity,
} from "@/services/exercise-map";
import { exerciseMatchesIdentityHints } from "@/services/exercise-compat";
import {
  sameMovement,
  type TextParserExercise,
} from "@/lib/program-preparation-text-parser";

export type EditExercise = TextParserExercise & {
  equipment?: string[];
  loadType?: string;
  loadSemantics?: string;
  family?: string | null;
  movementPattern?: string;
  variantAttributes?: Record<
    string,
    string | boolean | null | undefined
  > | null;
};
export type RankedExercise = {
  id: string;
  name: string;
  rank: number;
  equivalent: boolean;
  explanation: string;
};
const tokens = (value: string) => {
  const aliases: Record<string, string> = {
    ohp: "overhead press",
    rdl: "romanian deadlift",
    bench: "bench press",
    bss: "bulgarian split squat",
  };
  const normalized = normalizeExerciseText(value).replace(
    /\b(?:extensions|curls|raises|flyes|flies|presses|rows|squats|pushdowns)\b/g,
    (word) =>
      ({
        extensions: "extension",
        curls: "curl",
        raises: "raise",
        flyes: "fly",
        flies: "fly",
        presses: "press",
        rows: "row",
        squats: "squat",
        pushdowns: "pushdown",
      })[word]!,
  );
  return (aliases[normalized] ?? normalized)
    .replace(/\b(?:the|established|exercise|sets|set)\b/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
};
const material = new Set([
  "seated",
  "standing",
  "incline",
  "decline",
  "unilateral",
  "bilateral",
  "one",
  "single",
  "arm",
  "leg",
  "supported",
  "chest",
  "wide",
  "narrow",
  "grip",
  "assisted",
  "weighted",
]);

/** Deterministic ranking points, not a statistical confidence estimate. */
export function rankEditExercises(
  query: string,
  library: readonly EditExercise[],
  currentReference = false,
): RankedExercise[] {
  const wanted = tokens(query);
  if (!wanted.length) return [];
  const hints = extractExerciseIdentity(query);
  return library
    .map((exercise) => {
      const identityCompatible =
        !exercise.equipment ||
        !exercise.loadType ||
        !exercise.loadSemantics ||
        exerciseMatchesIdentityHints(
          {
            ...exercise,
            equipment: exercise.equipment,
            loadType: exercise.loadType,
            loadSemantics: exercise.loadSemantics,
          },
          hints,
        );
      const names = [exercise.name, ...(exercise.aliases ?? [])];
      let rank = 0;
      let equivalent = false;
      for (const name of names) {
        const candidate = tokens(name);
        const overlap = wanted.filter((word) =>
          candidate.includes(word),
        ).length;
        const missing = wanted.filter((word) => !candidate.includes(word));
        const extraMaterial = candidate.filter(
          (word) => material.has(word) && !wanted.includes(word),
        );
        const equivalentWords =
          wanted.slice().sort().join(" ") ===
          candidate.slice().sort().join(" ");
        const knownEquivalent =
          equivalentWords ||
          sameMovement(wanted.join(" "), candidate.join(" "));
        const shortCurrent =
          currentReference &&
          missing.length === 0 &&
          (extraMaterial.length === 0 ||
            /^(?:curl|pushdown|lateral raise|reverse fly)$/.test(
              wanted.join(" "),
            ));
        equivalent ||= identityCompatible && (knownEquivalent || shortCurrent);
        const points = Math.max(
          0,
          overlap * 20 -
            missing.length * 18 -
            extraMaterial.length * 6 +
            (knownEquivalent ? 100 : 0),
        );
        rank = Math.max(rank, points);
      }
      // Metadata helps rank candidates but cannot erase an explicitly named material variant.
      const metadata = tokens(
        [
          exercise.family,
          exercise.movementPattern,
          ...Object.values(exercise.variantAttributes ?? {}).filter(
            (value) => typeof value === "string",
          ),
        ]
          .filter(Boolean)
          .join(" "),
      );
      if (rank > 0)
        rank += wanted.filter((word) => metadata.includes(word)).length * 2;
      if (!identityCompatible) {
        equivalent = false;
        rank = Math.max(0, rank - 40);
      }
      return {
        id: exercise.id,
        name: exercise.name,
        rank,
        equivalent,
        explanation: equivalent
          ? "Name or alias matches within this scope"
          : "Related wording; confirm the movement and variant",
      };
    })
    .filter((item) => item.rank > 0)
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

export function mergeEffortNotes(
  existing: string | null,
  authored: string,
  mode: "replace" | "append" | "modify",
): { value: string | null; warning?: string; question?: string } {
  let text = authored
    .trim()
    .replace(/^[“"]|[”"]$/g, "")
    .replace(/^:\s*/, "");
  const targetEdit =
    /^change the RIR target from (\d+(?:[–-]\d+)?) to (\d+(?:[–-]\d+)?)$/i.exec(
      text,
    );
  if (targetEdit) {
    const escaped = targetEdit[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `\\b${escaped}\\s*(?:RIR|(?:reps?|repetitions?) in reserve)\\b`,
      "gi",
    );
    if (!existing || !pattern.test(existing))
      return {
        value: existing,
        question: `The saved notes do not contain the stated ${targetEdit[1]} RIR target. Specify the intended note.`,
      };
    return { value: existing.replace(pattern, `${targetEdit[2]} RIR`) };
  }
  // The authored final-set guidance does not authorize a new early-set target.
  const effort = /\b(?:RIR|RPE|(?:reps?|repetitions?) in reserve|failure)\b/i;
  const finalOnly =
    /\b(?:final|last) set\b/i.test(text) &&
    !/\b(?:earlier|first|all|every|most)\b.*\bsets?\b/i.test(text);
  const earlyOnly =
    /\b(?:earlier|first|most)\b.*\bsets?\b/i.test(text) &&
    !/\b(?:final|last) set\b/i.test(text);
  const pureEffortClause = (clause: string) =>
    !clause
      .replace(
        /\b(?:RIR|RPE|(?:reps?|repetitions?) in reserve|failure)\b/gi,
        "",
      )
      .replace(/\d+(?:\.\d+)?/g, "")
      .replace(
        /\b(?:use|target|aim|for|leave|keep|approximately|about|around|at|on|the|a|an|sets?|working|first|last|final|earlier|all|every|most|two|three|four|five|six|technically|sound|may|can|occasionally|reach|stop|no|more|less|than|and|of|to)\b/gi,
        "",
      )
      .replace(/[^a-z]/gi, "")
      .trim();
  const oldParts = (existing ?? "")
    .split(/\n|(?<=[.!?])\s+|;\s*/)
    .filter(Boolean);
  const contradictions = oldParts.filter(
    (part) => effort.test(part) && effort.test(text) && part !== text,
  );
  let retained = oldParts;
  if (mode === "replace") retained = [];
  if (mode === "modify" && effort.test(text)) {
    retained = [];
    for (const part of oldParts) {
      if (!effort.test(part)) {
        retained.push(part);
        continue;
      }
      if (
        (finalOnly || earlyOnly) &&
        (/\b(?:all|every) sets?\b/i.test(part) ||
          (/\b(?:earlier|first|most)\b/i.test(part) &&
            /\b(?:final|last) set\b/i.test(part)))
      )
        return {
          value: existing,
          question:
            "The saved note combines early and final-set targets. Provide the complete intended note so a partial effort update cannot erase another set's guidance.",
        };
      if (earlyOnly && /\b(?:final|last) set\b/i.test(part)) {
        retained.push(part);
        continue;
      }
      if (finalOnly && !/\b(?:final|last|all|every)\s+sets?\b/i.test(part)) {
        retained.push(part);
        continue;
      }
      // Preserve an attached safety clause when it can be separated exactly.
      const clauses = part.split(
        /;\s*|,\s*(?=(?:keep|use|with|while|stop|maintain)\b)/i,
      );
      const safety = clauses.filter((clause) => !effort.test(clause));
      if (
        clauses.some(
          (clause) => effort.test(clause) && !pureEffortClause(clause),
        )
      )
        return {
          value: existing,
          question:
            "The current effort target shares a sentence with other guidance. Provide the complete replacement note so that guidance is preserved.",
        };
      retained.push(...safety);
    }
  }
  if (mode === "append" && contradictions.length)
    return {
      value: existing,
      question:
        "The added effort note may conflict with the saved target. Use an update or replacement note, or clarify which sets each target covers.",
    };
  if (
    !retained.some(
      (part) => part.replace(/[.]$/, "") === text.replace(/[.]$/, ""),
    )
  )
    retained.push(text);
  text = retained.join("\n");
  if (text.length > 2000)
    return {
      value: existing,
      question:
        "The resulting notes exceed 2,000 characters. Shorten this note.",
    };
  return {
    value: text || null,
    ...(contradictions.length && mode !== "append"
      ? {
          warning:
            "The earlier effort guidance is replaced; review the old and new notes below.",
        }
      : {}),
  };
}
