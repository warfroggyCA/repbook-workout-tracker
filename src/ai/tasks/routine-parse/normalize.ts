import { createHash } from "node:crypto";
import {
  PROGRAM_INPUT_SCHEMA_VERSION,
  routineParseSchema,
  type RoutineParseDraftResult,
  type RoutineParseResult,
} from "@/ai/tasks/routine-parse/schema";

const PROGRAM_INPUT_IDENTITY_NAMESPACE =
  "7d6365f2-b64f-5d51-908d-31dbb17b8ef0";

/**
 * Whitespace-only paste differences do not create new package identities. The
 * source itself is never retained here; only its in-memory digest participates
 * in UUID derivation.
 */
export function canonicalizeRoutineIdentitySource(sourceText: string) {
  return sourceText
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter(Boolean)
    .join("\n");
}

function namespaceBytes(namespace: string) {
  return Buffer.from(namespace.replaceAll("-", ""), "hex");
}

/** RFC 4122 name-based UUID used only for package-local stable lineage. */
function uuidV5(name: string) {
  const hash = createHash("sha1")
    .update(namespaceBytes(PROGRAM_INPUT_IDENTITY_NAMESPACE))
    .update(name, "utf8")
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sourceDigest(sourceText: string) {
  return createHash("sha256")
    .update(canonicalizeRoutineIdentitySource(sourceText), "utf8")
    .digest("hex");
}

function identity(
  digest: string,
  entity: "day" | "exercise" | "warmup",
  dayIndex: number,
  itemIndex?: number,
) {
  return uuidV5(
    [
      PROGRAM_INPUT_SCHEMA_VERSION,
      digest,
      entity,
      String(dayIndex),
      itemIndex == null ? "" : String(itemIndex),
    ].join("\u0000"),
  );
}

/**
 * Converts untrusted provider output into the final Program-input contract.
 * Provider identities are structurally impossible and every ID is derived
 * from normalized source plus ordinal, so a duplicate paste is stable even
 * when provider wording elsewhere varies.
 */
export function normalizeRoutineParseDraftEnvelope(
  draft: RoutineParseDraftResult,
  sourceText: string,
): RoutineParseResult {
  const digest = sourceDigest(sourceText);
  return routineParseSchema.parse({
    ...draft,
    data: {
      schemaVersion: PROGRAM_INPUT_SCHEMA_VERSION,
      programName: draft.data.programName,
      days: draft.data.days.map((day, dayIndex) => {
        const exerciseLineages = day.exercises.map((_, exerciseIndex) =>
          identity(digest, "exercise", dayIndex, exerciseIndex),
        );
        const warmups = [
          ...day.warmupItems.map((item) => ({
            item,
            beforeSlotLineageId: null,
          })),
          ...day.exercises.flatMap((exercise, exerciseIndex) =>
            exercise.rampUps.map((item) => ({
              item,
              beforeSlotLineageId: exerciseLineages[exerciseIndex]!,
            })),
          ),
        ].sort((left, right) => left.item.sourceOrder - right.item.sourceOrder);
        return {
          lineageId: identity(digest, "day", dayIndex),
          name: day.name,
          order: day.order,
          warmupItems: warmups.map(({ item, beforeSlotLineageId }, itemIndex) => {
            const { sourceOrder, ...retainedItem } = item;
            void sourceOrder;
            return {
              key: identity(digest, "warmup", dayIndex, itemIndex),
              beforeSlotLineageId,
              ...retainedItem,
            };
          }),
          exercises: day.exercises.map((inputExercise, exerciseIndex) => {
            const { rampUps, ...exercise } = inputExercise;
            void rampUps;
            return {
              lineageId: exerciseLineages[exerciseIndex]!,
              ...exercise,
            };
          }),
        };
      }),
    },
  });
}
