import {
  programUpdateSchema,
  type ProgramTextUpdate,
} from "@/ai/tasks/program-update/schema";
import {
  programDocumentV3Schema,
  type ProgramDocumentV3,
} from "@/lib/program-document";
import {
  addSupersetGroup,
  normalizeDaySupersets,
  createDefaultProgramSlot,
  removeProgramSlotFromDay,
  resizeProgramSlotSets,
} from "@/lib/program-editor-client";

export type ProgramEditIssue = {
  key: string;
  question: string;
  source: string;
  candidates?: Array<{ id: string; name: string; explanation: string }>;
};
export type ProgramTextProposal = {
  baseDocument: ProgramDocumentV3;
  changes: Array<
    ProgramTextUpdate["changes"][number] & {
      id: string; summary: string; instructionKeys?: string[]; blocked?: boolean;
      warnings?: string[];
    }
  >;
  questions: string[];
  interpretation?: { version: 1; issues: ProgramEditIssue[]; information: string[] };
};

export function applyProgramTextChanges(
  current: ProgramDocumentV3,
  proposal: ProgramTextProposal,
  selected: ReadonlySet<string>,
): ProgramDocumentV3 {
  if (proposal.questions.length && !proposal.interpretation)
    throw new Error("Resolve every clarification and compare again before applying this request. Your draft is unchanged.");
  if (JSON.stringify(current) !== JSON.stringify(proposal.baseDocument))
    throw new Error(
      "The draft changed. Compare your request again before applying it.",
    );
  let result = structuredClone(current);
  for (const change of proposal.changes) {
    if (!selected.has(change.id)) continue;
    if (change.blocked) throw new Error("This change still needs clarification. Your draft is unchanged.");
    // A replacement starts fresh lineage. Later operations in the SAME reviewed
    // change still address the original slot; other selectable changes cannot
    // depend on a replacement that the owner might leave unselected.
    const replacedSlots = new Map<string, string>();
    for (const [index, op] of change.operations.entries()) {
      const day = result.days.find((item) => item.lineageId === op.dayId);
      if (!day) throw new Error("The proposed day is no longer available.");
      const slot =
        "slotId" in op && op.slotId
          ? day.exercises.find((item) => item.lineageId === (replacedSlots.get(op.slotId!) ?? op.slotId))
          : null;
      if ("slotId" in op && op.slotId && !slot)
        throw new Error("The proposed exercise is no longer available.");
      // IDs are assigned locally, once per proposal, and remain stable on selection retries.
      const id = () => stableProposalId(change.id, index * 100 + 99);
      switch (op.kind) {
        case "group": {
          const members = [...op.slotIds];
          for (const exerciseId of op.exerciseIds) {
            const matches = day.exercises.filter(
              (item) => item.exerciseId === exerciseId,
            );
            if (matches.length !== 1)
              throw new Error(
                "A proposed group member is ambiguous or missing.",
              );
            members.push(matches[0].lineageId);
          }
          if (
            members.length < 2 ||
            new Set(members).size !== members.length ||
            members.some(
              (key) => !day.exercises.some((item) => item.lineageId === key),
            )
          )
            throw new Error("A group needs distinct exercises from this day.");
          for (const member of day.exercises.filter((item) =>
            members.includes(item.lineageId),
          )) {
            member.supersetKey = null;
            member.groupMemberOrderIdx = null;
          }
          Object.assign(day, normalizeDaySupersets(day));
          Object.assign(
            day,
            addSupersetGroup(
              day,
              {
                key: id(),
                name: op.name,
                structureStatus: "canonical",
                plannedRounds: op.rounds,
                restBetweenMembersSec: op.restBetweenMembersSec,
                restBetweenRoundsSec: op.restBetweenRoundsSec,
                restAfterRoundSec: op.restAfterRoundSec,
              },
              members,
            ),
          );
          for (const member of day.exercises.filter((item) =>
            members.includes(item.lineageId),
          ))
            member.groupMemberOrderIdx = members.indexOf(member.lineageId);
          break;
        }
        case "ungroup": {
          if (!day.supersets.some((item) => item.key === op.groupId))
            throw new Error("The group is no longer available.");
          day.supersets = day.supersets.filter(
            (item) => item.key !== op.groupId,
          );
          for (const member of day.exercises)
            if (member.supersetKey === op.groupId) {
              member.supersetKey = null;
              member.groupMemberOrderIdx = null;
            }
          break;
        }
        case "warmup": {
          const anchor = slot?.lineageId ?? op.slotId;
          const retained = day.warmupItems.filter(
            (item) => (item.beforeSlotLineageId ?? null) !== anchor,
          );
          const items = op.items.map((item, itemIndex) => ({
            ...item,
            key: stableProposalId(change.id, index * 100 + itemIndex + 1),
            beforeSlotLineageId: anchor,
          }));
          const rank = (key: string | null | undefined) =>
            key == null
              ? -1
              : day.exercises.findIndex(
                  (exercise) => exercise.lineageId === key,
                );
          const firstLater = retained.findIndex(
            (item) => rank(item.beforeSlotLineageId) > rank(anchor),
          );
          const position = firstLater < 0 ? retained.length : firstLater;
          day.warmupItems = [
            ...retained.slice(0, position),
            ...items,
            ...retained.slice(position),
          ];
          if (slot) {
            slot.warmupNotes = op.notes;
            slot.warmupSets = [];
          } else day.warmupNotes = op.notes;
          break;
        }
        case "slot_number":
          if (slot) {
            if (op.field === "sets")
              Object.assign(slot, resizeProgramSlotSets(slot, op.value));
            else slot.restSec = op.value;
          }
          break;
        case "reps":
          if (slot?.timedPrescription)
            throw new Error(
              "Timed exercise targets need an explicit metric change.",
            );
          if (slot) {
            slot.repMin = op.min;
            slot.repMax = op.max;
          }
          break;
        case "load":
          if (slot) {
            slot.targetLoad = op.value;
            slot.targetLoadUnit = op.unit;
          }
          break;
        case "slot_text":
          if (slot) {
            if (op.field === "notes") slot.notes = op.value;
            else {
              if (
                !op.value ||
                ![
                  "manual",
                  "hold",
                  "double_progression",
                  slot.progressionRuleId,
                ].includes(op.value)
              )
                throw new Error("Unknown progression rule.");
              slot.progressionRuleId = op.value;
            }
          }
          break;
        case "day_text":
          if (op.field === "notes") day.notes = op.value;
          else {
            if (!op.value) throw new Error("A day needs a name.");
            day.name = op.value;
          }
          break;
        case "reorder": {
          if (
            op.slotIds.length !== day.exercises.length ||
            new Set(op.slotIds).size !== day.exercises.length ||
            op.slotIds.some(
              (key) => !day.exercises.some((item) => item.lineageId === key),
            )
          )
            throw new Error(
              "Exercise order must retain every exercise exactly once.",
            );
          day.exercises = op.slotIds.map(
            (key) => day.exercises.find((item) => item.lineageId === key)!,
          );
          for (const group of day.supersets) {
            day.exercises
              .filter((member) => member.supersetKey === group.key)
              .forEach((member, memberIndex) => {
                member.groupMemberOrderIdx = memberIndex;
              });
          }
          break;
        }
        case "remove":
          if (day.exercises.length <= 1)
            throw new Error("A day needs at least one exercise.");
          Object.assign(day, removeProgramSlotFromDay(day, op.slotId));
          break;
        case "replace":
          if (slot && slot.exerciseId !== op.exerciseId) {
            const oldId = slot.lineageId;
            slot.exerciseId = op.exerciseId;
            slot.lineageId = id();
            replacedSlots.set(oldId, slot.lineageId);
            slot.warmupNotes = null;
            slot.warmupSets = [];
            slot.notes = null;
            slot.setNotes = slot.setNotes.map(() => null);
            day.warmupItems = day.warmupItems.filter(
              (item) => item.beforeSlotLineageId !== oldId,
            );
            day.intent.identity.anchorSlotLineageIds =
              day.intent.identity.anchorSlotLineageIds.map((key) =>
                key === oldId ? slot.lineageId : key,
              );
          }
          break;
        case "add": {
          const position =
            op.afterSlotId === null
              ? -1
              : day.exercises.findIndex(
                  (item) => item.lineageId === op.afterSlotId,
                );
          if (op.afterSlotId && position < 0)
            throw new Error("The insertion point is no longer available.");
          const added = resizeProgramSlotSets(
            createDefaultProgramSlot(op.exerciseId, id()),
            op.sets,
          );
          Object.assign(added, {
            repMin: op.repMin,
            repMax: op.repMax,
            restSec: op.restSec,
            targetLoad: op.load,
            targetLoadUnit: op.loadUnit,
          });
          day.exercises.splice(position + 1, 0, added);
          break;
        }
      }
    }
  }
  // Preserve group invariants without silently changing unrequested members.
  for (const day of result.days)
    for (const group of day.supersets) {
      if (group.structureStatus === "canonical") {
        const members = day.exercises.filter(
          (slot) => slot.supersetKey === group.key,
        );
        if (members.some((slot) => slot.sets !== members[0]?.sets))
          throw new Error(
            "Grouped exercises need matching sets. Include all members in the requested change.",
          );
        group.plannedRounds = members[0]?.sets ?? group.plannedRounds;
      }
    }
  result = programDocumentV3Schema.parse(result);
  return result;
}

function stableProposalId(id: string, offset: number) {
  // UUID prefix is random per change; low 12 digits reserve operation/item identity.
  return `${id.slice(0, 24)}${offset.toString(16).padStart(12, "0")}`;
}

export function buildProgramTextProposal(
  current: ProgramDocumentV3,
  value: unknown,
  request: string,
  library: ReadonlyArray<{
    id: string;
    name: string;
    available: boolean;
    metricType: string;
  }>,
  createId = () => crypto.randomUUID(),
): ProgramTextProposal {
  const parsed = programUpdateSchema.parse(value);
  const names = new Map(library.map((item) => [item.id, item.name]));
  const normalize = (text: string) =>
    text.normalize("NFKC").replace(/\s+/g, " ").trim();
  const proposal: ProgramTextProposal = {
    baseDocument: current,
    changes: [],
    questions: parsed.questions,
  };
  const warmupOnly =
    /\b(?:warm[ -]?ups?|preparation)(?:[ -]+only|\s+(?:updates?|changes?)\s+only)\b|\bonly\s+(?:(?:change|update|edit)\s+)?(?:the\s+)?(?:warm[ -]?ups?|preparation)\b/i.test(
      request,
    ) ||
    /^\s*warm[ -]?up update\s*[—–:-]\s*future workouts only\s*$/im.test(
      request,
    );
  const editedFields = new Set<string>();
  for (const change of parsed.changes) {
    if (warmupOnly && change.operations.some((op) => op.kind !== "warmup"))
      throw new Error(
        "A preparation-only request cannot change working prescriptions.",
      );
    if (!normalize(request).includes(normalize(change.sourceQuote)))
      throw new Error("The proposal could not be traced to your request.");
    for (const op of change.operations) {
      if (!["add", "group", "ungroup"].includes(op.kind)) {
        const field = `${op.dayId}:${"slotId" in op ? op.slotId : "day"}:${"field" in op ? op.field : op.kind}`;
        if (editedFields.has(field))
          throw new Error(
            "The proposal contains conflicting edits. Compare again to resolve them.",
          );
        editedFields.add(field);
      }
      if (op.kind === "add" || op.kind === "replace") {
        const exercise = library.find((item) => item.id === op.exerciseId);
        if (!exercise?.available)
          throw new Error(
            "A proposed exercise is unavailable for your equipment.",
          );
        const sourceSlot =
          op.kind === "replace"
            ? current.days
                .find((day) => day.lineageId === op.dayId)
                ?.exercises.find((slot) => slot.lineageId === op.slotId)
            : null;
        if (
          !["weight_reps", "reps", "assisted_reps"].includes(
            exercise.metricType,
          ) ||
          sourceSlot?.timedPrescription ||
          (sourceSlot &&
            !["weight_reps", "reps", "assisted_reps"].includes(
              library.find((item) => item.id === sourceSlot.exerciseId)
                ?.metricType ?? "unknown",
            ))
        )
          throw new Error(
            "Timed or distance exercise changes need an explicit metric prescription. Edit those targets in the Program editor.",
          );
      }
    }
    const summary = change.operations
      .map((op) => {
        const day = current.days.find((item) => item.lineageId === op.dayId);
        const slot =
          "slotId" in op
            ? day?.exercises.find((item) => item.lineageId === op.slotId)
            : null;
        const label = `${day?.name ?? "Unknown day"}${slot ? ` · ${names.get(slot.exerciseId) ?? "Exercise"}` : ""}`;
        if (op.kind === "group")
          return `${label}: group ${op.slotIds
            .map(
              (key) =>
                names.get(
                  day?.exercises.find((item) => item.lineageId === key)
                    ?.exerciseId ?? "",
                ) ?? "exercise",
            )
            .concat(op.exerciseIds.map((key) => names.get(key) ?? "exercise"))
            .join(
              " + ",
            )} for ${op.rounds} rounds; ${op.restBetweenMembersSec}s between members, ${op.restBetweenRoundsSec}s between rounds`;
        if (op.kind === "ungroup")
          return `${label}: ungroup ${day?.supersets.find((item) => item.key === op.groupId)?.name ?? "exercises"}`;
        if (op.kind === "warmup")
          return `${label}: ${op.items.length} preparation ${op.items.length === 1 ? "step" : "steps"}${op.notes ? `; ${op.notes}` : ""}\n${op.items.map((item) => `${item.label}${item.reps !== null ? ` × ${item.reps}` : ""}${item.load !== null ? ` at ${item.load} ${item.loadUnit}` : ""}${item.loadPercent !== null ? ` at ${item.loadPercent}%` : ""}${item.loadText ? ` · ${item.loadText}` : ""}${item.notes ? ` · ${item.notes}` : ""}`).join("\n")}`;
        if (op.kind === "slot_number")
          return `${label}: ${op.field === "sets" ? "sets" : "rest (seconds)"} ${slot?.[op.field]} → ${op.value}`;
        if (op.kind === "reps")
          return `${label}: reps ${slot?.repMin}–${slot?.repMax} → ${op.min}–${op.max}`;
        if (op.kind === "load")
          return `${label}: load ${slot?.targetLoad ?? "unspecified"} ${slot?.targetLoadUnit ?? ""} → ${op.value ?? "unspecified"} ${op.unit ?? ""}`;
        if (op.kind === "slot_text" || op.kind === "day_text")
          return `${label}: ${op.field}\nOld: ${(op.kind === "slot_text" ? slot?.[op.field] : day?.[op.field]) ?? "none"}\nNew: ${op.value ?? "clear"}`;
        if (op.kind === "replace")
          return `${label}: replace with ${names.get(op.exerciseId) ?? "exercise"}\nOriginal: ${slot?.sets} × ${slot?.repMin}–${slot?.repMax}, ${slot?.restSec}s rest. Attached prescription changes are listed below.\nMovement-specific notes and preparation start fresh for the replacement.${slot?.notes ? `\nOld notes: ${slot.notes}` : ""}`;
        if (op.kind === "add")
          return `${label}: add ${names.get(op.exerciseId) ?? "exercise"}, ${op.sets} × ${op.repMin}–${op.repMax}, ${op.restSec}s rest`;
        return `${label}: ${op.kind === "remove" ? "remove exercise" : "change exercise order"}`;
      })
      .join("\n");
    proposal.changes.push({ ...change, id: createId(), summary });
  }
  // Unresolved requests are preview-only. In particular, a replacement warm-up
  // must not indirectly execute an unresolved conditional removal.
  if (!proposal.questions.length)
    applyProgramTextChanges(current, proposal, new Set(proposal.changes.map((change) => change.id)));
  return proposal;
}
