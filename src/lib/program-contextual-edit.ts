import type { ProgramDocumentV3 } from "@/lib/program-document";
import type { ProgramUpdateOperation as Operation } from "@/ai/tasks/program-update/schema";
import { parseProgramTextUpdate } from "@/lib/program-text-parser";
import {
  parseProgramDose,
  parseWorkingTextUpdate,
  resolveProgramTextDay,
} from "@/lib/program-working-text-parser";
import {
  interpretProgramEdit,
  executableCondition,
  embeddedProgramCommand,
  coachingLanguage,
  type EditInstruction,
} from "@/lib/program-edit-language";
import {
  rankEditExercises,
  mergeEffortNotes,
  type EditExercise,
} from "@/lib/program-edit-resolution";
import {
  applyProgramTextChanges,
  buildProgramTextProposal,
  type ProgramTextProposal,
  type ProgramEditIssue,
} from "@/lib/program-text-update";

type Day = ProgramDocumentV3["days"][number];
type Slot = Day["exercises"][number];
type Target = { day: Day; slot: Slot };
type Bucket = {
  targets: Target[];
  operations: Operation[];
  keys: Set<string>;
  source: string;
  questions: ProgramEditIssue[];
  warnings: string[];
};
export type ProgramEditAnswers = Record<string, string>;

/** Stage B resolves inherited references, enforces constraints, and lowers to
 * the existing validated Program operation contract. No persistence or AI. */
export function proposeContextualProgramEdit(
  current: ProgramDocumentV3,
  text: string,
  library: readonly EditExercise[],
  activeDayId: string | null = null,
  answers: ProgramEditAnswers = {},
  appliedKeys: readonly string[] = [],
): ProgramTextProposal {
  const empty = (question: string): ProgramTextProposal => ({
    baseDocument: current,
    changes: [],
    questions: [question],
  });
  if (
    !text.trim() ||
    text.length > 20000 ||
    /[\u0000\u202a-\u202e\u2066-\u2069]/u.test(text)
  )
    return empty(
      "Use 1–20,000 characters without hidden direction or null characters.",
    );
  // Preparation replacement can overlap a conditional removal at any anchor.
  // Keep the established all-or-nothing preparation boundary until each anchor
  // has a complete resolution; partial working-edit semantics never weaken it.
  if (
    /(?:^|\n)\s*(?:[•*\-]\s+|#{1,6}\s*)?(?:(?:immediately\s+)?before\s+[^\n]+:|start of (?:each|every) day|warm[ -]?up update|update warm[ -]?up only)/i.test(
      text,
    )
  )
    return buildProgramTextProposal(
      current,
      parseProgramTextUpdate(current, text, library, activeDayId),
      text,
      [...library],
    );
  const interpreted = interpretProgramEdit(
    text,
    current.days.map((day) => day.name),
  );
  if (interpreted.instructions.length > 200)
    return empty(
      "Compare at most 200 instructions at a time. Nothing was applied.",
    );
  const assertions: Array<{
    target: Target;
    ops: Operation[];
    instruction: EditInstruction;
  }> = [];
  const buckets: Bucket[] = [];
  const checkedPreservations: string[] = [];
  const firstPositionAssertions: Target[] = [];
  const notePlans = new Map<
    string,
    { target: Target; instructions: EditInstruction[] }
  >();
  const globalIssues: ProgramEditIssue[] = [];
  const information: string[] = [];
  const byId = new Map(library.map((item) => [item.id, item]));
  const allTargets = current.days.flatMap((day) =>
    day.exercises.map((slot) => ({ day, slot })),
  );
  const alreadyApplied = new Set(appliedKeys);
  const bucketFor = (targets: Target[], instruction: EditInstruction) => {
    const overlap = buckets.filter((bucket) =>
      targets.some((target) =>
        bucket.targets.some(
          (item) => item.slot.lineageId === target.slot.lineageId,
        ),
      ),
    );
    const bucket = overlap[0] ?? {
      targets: [],
      operations: [],
      keys: new Set<string>(),
      source: instruction.source,
      questions: [],
      warnings: [],
    };
    if (!overlap.length) buckets.push(bucket);
    for (const other of overlap.slice(1)) {
      bucket.targets.push(...other.targets);
      bucket.operations.push(...other.operations);
      other.keys.forEach((key) => bucket.keys.add(key));
      bucket.questions.push(...other.questions);
      bucket.warnings.push(...other.warnings);
      buckets.splice(buckets.indexOf(other), 1);
    }
    for (const target of targets)
      if (
        !bucket.targets.some(
          (item) => item.slot.lineageId === target.slot.lineageId,
        )
      )
        bucket.targets.push(target);
    bucket.keys.add(instruction.key);
    return bucket;
  };
  const ask = (
    instruction: EditInstruction,
    question: string,
    bucket?: Bucket,
    candidates?: ProgramEditIssue["candidates"],
    suffix = "",
  ) => {
    const issue = {
      key: `${instruction.key}${suffix}`,
      question,
      source: instruction.source,
      ...(candidates?.length ? { candidates } : {}),
    };
    (bucket?.questions ?? globalIssues).push(issue);
  };
  const scopedDays = (instruction: EditInstruction) => {
    const days = instruction.scope.day
      ? resolveProgramTextDay(current, instruction.scope.day, activeDayId)
      : activeDayId
        ? current.days.filter((day) => day.lineageId === activeDayId)
        : current.days;
    const routine = /\broutine\s+([a-z]|\d+)\b/i.exec(
      instruction.scope.day ?? "",
    );
    if (
      routine &&
      resolveProgramTextDay(current, `Routine ${routine[1]}`, activeDayId)[0]
        ?.lineageId !== days[0]?.lineageId
    )
      return [];
    return days;
  };
  const resolve = (
    query: string,
    instruction: EditInstruction,
  ): Target | null => {
    const days = scopedDays(instruction);
    if (days.length === 0) {
      ask(
        instruction,
        `The day “${instruction.scope.day}” is not in the current Program.`,
      );
      return null;
    }
    const possible = allTargets.filter((target) => days.includes(target.day));
    const ranks = rankEditExercises(
      query.replace(/\s+first$/i, ""),
      possible
        .map((target) => byId.get(target.slot.exerciseId)!)
        .filter(Boolean),
      true,
    );
    const equivalents = ranks.filter((item) => item.equivalent);
    const exactTargets = possible.filter((target) =>
      equivalents.some((item) => item.id === target.slot.exerciseId),
    );
    if (exactTargets.length === 1) return exactTargets[0];
    const candidates = possible.filter((target) =>
      ranks.some((item) => item.id === target.slot.exerciseId),
    );
    const chosen = candidates.find(
      (target) =>
        target.slot.lineageId ===
        answers[
          `source:${instruction.scope.day ?? "all"}:${query.toLowerCase()}`
        ],
    );
    if (chosen) return chosen;
    const bucket = bucketFor(
      candidates.length ? candidates : possible,
      instruction,
    );
    ask(
      instruction,
      `Which exercise does “${query}” mean${instruction.scope.day ? ` on ${instruction.scope.day}` : ""}?`,
      bucket,
      candidates.slice(0, 8).map((target) => ({
        id: target.slot.lineageId,
        name: `${target.day.name} · ${byId.get(target.slot.exerciseId)?.name}`,
        explanation: "Select this saved exercise",
      })),
      ":source",
    );
    bucket.questions[bucket.questions.length - 1].key =
      `source:${instruction.scope.day ?? "all"}:${query.toLowerCase()}`;
    return null;
  };
  const add = (bucket: Bucket, op: Operation, instruction: EditInstruction) => {
    const field = (value: Operation) =>
      `${value.dayId}:${"slotId" in value ? value.slotId : "day"}:${"field" in value ? value.field : value.kind}`;
    const previous = bucket.operations.find(
      (item) => field(item) === field(op),
    );
    if (
      previous?.kind === "load" &&
      op.kind === "load" &&
      previous.value === null &&
      bucket.operations.some(
        (item) => item.kind === "replace" && item.slotId === op.slotId,
      )
    ) {
      previous.value = op.value;
      previous.unit = op.unit;
      return;
    }
    if (previous && JSON.stringify(previous) !== JSON.stringify(op)) {
      ask(
        instruction,
        "This exercise has conflicting changes to the same field. Specify one intended value.",
        bucket,
      );
      return;
    }
    if (!previous) bucket.operations.push(op);
  };
  const doseOps = (
    target: Target,
    value: NonNullable<ReturnType<typeof parseProgramDose>>,
  ): Operation[] => {
    const identity = {
      dayId: target.day.lineageId,
      slotId: target.slot.lineageId,
    };
    return [
      ...(value.sets !== undefined
        ? [
            {
              kind: "slot_number" as const,
              ...identity,
              field: "sets" as const,
              value: value.sets,
            },
          ]
        : []),
      ...(value.min !== undefined
        ? [
            {
              kind: "reps" as const,
              ...identity,
              min: value.min,
              max: value.max!,
            },
          ]
        : []),
      ...(value.rest !== undefined
        ? [
            {
              kind: "slot_number" as const,
              ...identity,
              field: "restSec" as const,
              value: value.rest,
            },
          ]
        : []),
      ...(value.load !== undefined
        ? [
            {
              kind: "load" as const,
              ...identity,
              value: value.load,
              unit: value.unit!,
            },
          ]
        : []),
    ];
  };
  const lowerLegacy = (
    instruction: EditInstruction,
    target?: Target,
    bucket?: Bucket,
  ) => {
    const day =
      target?.day ??
      (scopedDays(instruction).length === 1
        ? scopedDays(instruction)[0]
        : null);
    const command = instruction.text.replace(
      /^(increase|decrease|reduce)\s+(.+?)(?<!load|weight)\s+by\s+(\d+(?:\.\d+)?\s*(?:lb|kg))$/i,
      "$1 $2 load by $3",
    );
    const canonical = [
      day ? `Day ${current.days.indexOf(day) + 1}` : "",
      instruction.intent === "preserve" ? "KEEP:" : "",
      target ? `${byId.get(target.slot.exerciseId)?.name}:` : "",
      command,
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = parseWorkingTextUpdate(
      current,
      canonical,
      library,
      activeDayId,
    );
    if (
      instruction.intent === "preserve" &&
      !parsed.questions.length &&
      !parsed.changes.length
    )
      checkedPreservations.push(canonical);
    const ops = parsed.changes.flatMap((change) => change.operations);
    // Structural edits share a day-wide dependency boundary with every item
    // they can move/detach; an unresolved clause cannot leak through a reorder.
    const structuralDays = new Set(
      ops
        .filter((op) => !("slotId" in op) || op.kind === "remove")
        .map((op) => op.dayId),
    );
    const targets = allTargets.filter(
      (item) =>
        structuralDays.has(item.day.lineageId) ||
        ops.some((op) => "slotId" in op && op.slotId === item.slot.lineageId),
    );
    const group = targets.length ? bucketFor(targets, instruction) : bucket;
    if (parsed.questions.length) ask(instruction, parsed.questions[0], group);
    if (group) ops.forEach((op) => add(group, op, instruction));
    if (!ops.length && !parsed.questions.length)
      information.push(instruction.source);
  };
  for (const instruction of interpreted.instructions) {
    if (
      instruction.intent === "constraint" ||
      instruction.intent === "information"
    ) {
      information.push(instruction.source);
      continue;
    }
    if (alreadyApplied.has(instruction.key)) {
      information.push("Already applied to this draft: " + instruction.source);
      continue;
    }
    if (instruction.intent === "replace") {
      const target = resolve(instruction.scope.exercise ?? "", instruction);
      if (!target) continue;
      const bucket = bucketFor([target], instruction);
      if (executableCondition(instruction.text)) {
        ask(
          instruction,
          "Confirm the conditional replacement before changing this exercise and its attached prescription.",
          bucket,
        );
        continue;
      }
      const raw = instruction.text
        .replace(/^(?:replace|swap)\s+.+?\s+(?:with|for)\s+/i, "")
        .replace(/,?\s+in the same (?:exercise )?slot$/i, "");
      const parts = /^(.+?)(?:,\s*(\d+\s*(?:[×x]|sets?\b).*))?$/i.exec(raw)!;
      const candidates = rankEditExercises(
        parts[1],
        library.filter((item) => item.available),
      );
      const equivalents = candidates.filter((item) => item.equivalent);
      const selected =
        candidates.find(
          (item) => item.id === answers[`${instruction.key}:replacement`],
        ) ?? (equivalents.length === 1 ? equivalents[0] : null);
      if (!selected) {
        ask(
          instruction,
          `Which replacement should be used for ${byId.get(target.slot.exerciseId)?.name}? Its sets, rest, and notes stay together.`,
          bucket,
          candidates.slice(0, 8),
          ":replacement",
        );
        continue;
      }
      const existingCount =
        /^(?:replace|swap)\s+(?:the\s+)?(\d+|one|two|three|four)\s+(?:sets? of\s+|.+?\s+sets?\b)/i.exec(
          instruction.text,
        )?.[1];
      if (
        existingCount &&
        Number(
          ({ one: 1, two: 2, three: 3, four: 4 } as Record<string, number>)[
            existingCount
          ] ?? existingCount,
        ) !== target.slot.sets
      ) {
        ask(
          instruction,
          `The source has ${target.slot.sets} sets, which differs from the replacement request. Confirm the source set count.`,
          bucket,
        );
        continue;
      }
      add(
        bucket,
        {
          kind: "replace",
          dayId: target.day.lineageId,
          slotId: target.slot.lineageId,
          exerciseId: selected.id,
        },
        instruction,
      );
      add(
        bucket,
        {
          kind: "load",
          dayId: target.day.lineageId,
          slotId: target.slot.lineageId,
          value: null,
          unit: null,
        },
        instruction,
      );
      if (parts[2]) {
        const dose = parseProgramDose(parts[2]);
        if (!dose)
          ask(
            instruction,
            "The replacement prescription is incomplete or outside supported limits. Confirm its sets, reps, and rest together.",
            bucket,
          );
        else
          doseOps(target, dose).forEach((op) => add(bucket, op, instruction));
      }
      continue;
    }
    // A list of exercise families yields independently scoped notes; ambiguity
    // in one term does not erase recognized siblings.
    const familyText =
      instruction.scope.exercise &&
      /,|\band\b/.test(instruction.scope.exercise) &&
      instruction.intent === "notes"
        ? `${instruction.scope.exercise} should use ${instruction.text}`
        : instruction.text;
    const family =
      /^(?:established\s+)?(.+?)\s+(?:should\s+)?(?:use|target)\s+(.+)$/i.exec(
        familyText,
      );
    if (family && /,|\band\b/.test(family[1]) && coachingLanguage(family[2])) {
      for (const term of family[1].split(/,\s*|\s+and\s+/).filter(Boolean)) {
        const child = {
          ...instruction,
          key: `${instruction.key}|family:${term}`,
          scope: { ...instruction.scope, exercise: term },
          text: `Use ${family[2]}`,
        };
        if (alreadyApplied.has(child.key)) continue;
        const target = resolve(term, child);
        if (target) addNote(target, child);
      }
      continue;
    }
    let target: Target | null = instruction.scope.exercise
      ? resolve(instruction.scope.exercise, instruction)
      : null;
    if (instruction.scope.exercise && !target) continue;
    // Explicit "notes for X" and preservation assertions can name their target
    // directly without a heading. Leave other existing command grammar intact.
    const noteFor = /^(?:for|on)\s+(.+?)\s*:\s*(.+)$/i.exec(instruction.text);
    if (instruction.intent === "notes" && noteFor) {
      target = resolve(noteFor[1], instruction);
      if (target) addNote(target, { ...instruction, text: noteFor[2] });
      continue;
    }
    const groupText =
      /^(?:superset|group)\s+(.+?)\s+(?:with|and)\s+(.+?)(?:;\s*(.+))?$/i.exec(
        instruction.text,
      );
    const separate =
      /^keep\s+(.+?)\s+separate$/i.exec(instruction.text) ??
      /^remove\s+(.+?)\s+from\s+(?:its\s+)?superset(?:\s+.+)?$/i.exec(
        instruction.text,
      );
    const join = /^add\s+(.+?)\s+to\s+(superset\s+.+)$/i.exec(instruction.text);
    if (groupText || separate || join) {
      groupEdit(instruction, groupText, separate, join);
      continue;
    }
    if (instruction.intent === "notes") {
      if (target) addNote(target, instruction);
      else if (
        instruction.scope.day === null &&
        !noteFor &&
        /^(?:record actual effort|compare progress|RPE 9\.5 means)/i.test(
          instruction.text,
        )
      ) {
        for (const day of current.days) {
          const bucket = bucketFor(
            day.exercises.map((slot) => ({ day, slot })),
            instruction,
          );
          const previous = bucket.operations.find(
            (op) =>
              op.kind === "day_text" &&
              op.dayId === day.lineageId &&
              op.field === "notes",
          );
          if (previous?.kind === "day_text")
            previous.value = [previous.value, instruction.text]
              .filter(Boolean)
              .join("\n");
          else
            add(
              bucket,
              {
                kind: "day_text",
                dayId: day.lineageId,
                field: "notes",
                value: [day.notes, instruction.text].filter(Boolean).join("\n"),
              },
              instruction,
            );
        }
      } else
        ask(instruction, "Which exercise should receive this coaching note?");
      continue;
    }
    if (target) {
      const bucket = bucketFor([target], instruction);
      if (
        instruction.intent === "preserve" &&
        /\s+first$/i.test(instruction.scope.exercise ?? "")
      ) {
        if (target.day.exercises[0] !== target.slot)
          ask(
            instruction,
            "The KEEP instruction says this exercise is first, but the saved order differs. Confirm the intended order.",
            bucket,
          );
        else firstPositionAssertions.push(target);
      }
      if (executableCondition(instruction.text)) {
        ask(
          instruction,
          "This instruction contains conditional Program behavior. Confirm a concrete change or label it as coaching guidance.",
          bucket,
        );
        continue;
      }
      let value = instruction.text.replace(
        /^(?:keep|preserve|leave)\s+(?:at\s+)?/i,
        "",
      );
      if (
        instruction.intent === "preserve" &&
        /^(?:the )?(?:current )?(?:load target|working load|everything)(?: (?:the same|unchanged))?$/i.test(
          value,
        )
      ) {
        information.push(instruction.source);
        if (/load/i.test(value))
          assertions.push({
            target,
            instruction,
            ops: [
              {
                kind: "load",
                dayId: target.day.lineageId,
                slotId: target.slot.lineageId,
                value: target.slot.targetLoad,
                unit: target.slot.targetLoadUnit,
              },
            ],
          });
        continue;
      }
      value = value
        .replace(/^sets:\s*(.+)$/i, "$1 sets")
        .replace(/^reps:\s*(.+)$/i, "$1 reps")
        .replace(/^rest:\s*/i, "rest ")
        .replace(/^(?:suggested )?(?:starting )?prescription:\s*/i, "");
      const dose = parseProgramDose(value);
      if (dose) {
        const ops = doseOps(target, dose);
        if (instruction.intent === "preserve") {
          const mismatches = ops.some((op) =>
            op.kind === "slot_number"
              ? target!.slot[op.field] !== op.value
              : op.kind === "reps"
                ? target!.slot.repMin !== op.min ||
                  target!.slot.repMax !== op.max
                : op.kind === "load"
                  ? target!.slot.targetLoad !== op.value ||
                    target!.slot.targetLoadUnit !== op.unit
                  : false,
          );
          if (mismatches)
            ask(
              instruction,
              `KEEP differs from the saved prescription (${target.slot.sets} × ${target.slot.repMin}–${target.slot.repMax}, ${target.slot.restSec}s rest). Did you intend to change it?`,
              bucket,
            );
          else {
            information.push(instruction.source);
            assertions.push({ target, ops, instruction });
          }
        } else ops.forEach((op) => add(bucket, op, instruction));
        continue;
      }
      lowerLegacy(instruction, target, bucket);
    } else lowerLegacy(instruction);
  }

  function addNote(target: Target, instruction: EditInstruction) {
    const bucket = bucketFor([target], instruction);
    if (
      executableCondition(instruction.text) ||
      embeddedProgramCommand(instruction.text)
    ) {
      ask(
        instruction,
        "This note describes conditional or structured Program changes. Clarify the intended coaching guidance or structured rule.",
        bucket,
      );
      return;
    }
    const plan = notePlans.get(target.slot.lineageId) ?? {
      target,
      instructions: [],
    };
    plan.instructions.push(instruction);
    notePlans.set(target.slot.lineageId, plan);
  }
  function groupEdit(
    instruction: EditInstruction,
    creation: RegExpExecArray | null,
    separate: RegExpExecArray | null,
    join: RegExpExecArray | null,
  ) {
    const first = resolve((creation ?? separate ?? join)![1], instruction);
    if (!first) return;
    const bucket = bucketFor(
      first.day.exercises.map((slot) => ({ day: first.day, slot })),
      instruction,
    );
    if (creation) {
      const second = resolve(creation[2], {
        ...instruction,
        key: `${instruction.key}:member`,
      });
      if (!second || second.day !== first.day || second.slot === first.slot) {
        ask(
          instruction,
          "A superset needs distinct exercises on the same day.",
          bucket,
        );
        return;
      }
      // Do not invent timing. All values must be explicit for a new group.
      const timings =
        /^(\d+) rounds?, (\d+)s? between members, (\d+)s? between rounds, (\d+)s? after (?:the )?round$/i.exec(
          creation[3] ?? "",
        );
      if (!timings) {
        ask(
          instruction,
          "For this new superset, specify rounds and rest in seconds between members, between rounds, and after the round. Existing groups can be edited by name without restating their timing.",
          bucket,
        );
        return;
      }
      add(
        bucket,
        {
          kind: "group",
          dayId: first.day.lineageId,
          slotIds: [first.slot.lineageId, second.slot.lineageId],
          exerciseIds: [],
          name: "Superset",
          rounds: Number(timings[1]),
          restBetweenMembersSec: Number(timings[2]),
          restBetweenRoundsSec: Number(timings[3]),
          restAfterRoundSec: Number(timings[4]),
        },
        instruction,
      );
      return;
    }
    const groups = first.day.supersets.filter((group) =>
      separate
        ? group.key === first.slot.supersetKey
        : group.name.toLowerCase() === join![2].toLowerCase(),
    );
    if (separate && !first.slot.supersetKey) {
      information.push(instruction.source);
      return;
    }
    if (groups.length !== 1 || groups[0].plannedRounds == null) {
      ask(
        instruction,
        "Choose one existing superset with confirmed rounds and rest settings.",
        bucket,
      );
      return;
    }
    const group = groups[0];
    const members = first.day.exercises
      .filter(
        (slot) =>
          slot.supersetKey === group.key && (!separate || slot !== first.slot),
      )
      .map((slot) => slot.lineageId);
    if (join && !members.includes(first.slot.lineageId))
      members.push(first.slot.lineageId);
    add(
      bucket,
      { kind: "ungroup", dayId: first.day.lineageId, groupId: group.key },
      instruction,
    );
    if (members.length > 1)
      add(
        bucket,
        {
          kind: "group",
          dayId: first.day.lineageId,
          slotIds: members,
          exerciseIds: [],
          name: group.name,
          rounds: group.plannedRounds!,
          restBetweenMembersSec: group.restBetweenMembersSec,
          restBetweenRoundsSec: group.restBetweenRoundsSec,
          restAfterRoundSec: group.restAfterRoundSec,
        },
        instruction,
      );
  }
  for (const { target, instructions } of notePlans.values()) {
    const bucket = buckets.find((item) =>
      item.targets.some(
        (candidate) => candidate.slot.lineageId === target.slot.lineageId,
      ),
    )!;
    const replacement = bucket.operations.some(
      (op) => op.kind === "replace" && op.slotId === target.slot.lineageId,
    );
    const positives = instructions.filter(
      (item) => !/^(?:do not|don't|avoid|never|no)\b/i.test(item.text),
    );
    const effortClaims = positives.flatMap((item) =>
      [
        ...item.text.matchAll(
          /(\d+(?:\.\d+)?(?:[–-]\d+(?:\.\d+)?)?)\s*(RIR|repetitions? in reserve)|RPE\s*(\d+(?:\.\d+)?(?:[–-]\d+(?:\.\d+)?)?)/gi,
        ),
      ].map((match) => ({
        target: match[1] ?? match[3],
        metric: match[3] ? "RPE" : "RIR",
        final: /\b(?:final|last) set\b/i.test(item.text),
        instruction: item,
      })),
    );
    const conflict = effortClaims.some((claim, index) =>
      effortClaims
        .slice(index + 1)
        .some(
          (other) =>
            claim.instruction !== other.instruction &&
            claim.metric === other.metric &&
            claim.final === other.final &&
            claim.target !== other.target,
        ),
    );
    if (
      conflict ||
      instructions.filter((item) => item.noteMode === "replace").length > 1
    ) {
      ask(
        instructions[0],
        "Several different effort targets or replacement notes address the same sets. Provide one intended note for this exercise.",
        bucket,
      );
      continue;
    }
    const mode = instructions.some((item) => item.noteMode === "replace")
      ? "replace"
      : instructions.every((item) => item.noteMode === "append")
        ? "append"
        : "modify";
    const merged = mergeEffortNotes(
      replacement ? null : target.slot.notes,
      [...new Set(instructions.map((item) => item.text))].join("\n"),
      mode,
    );
    if (merged.question) {
      ask(instructions[0], merged.question, bucket);
      continue;
    }
    if (merged.warning) bucket.warnings.push(merged.warning);
    if (merged.value !== target.slot.notes || replacement)
      add(
        bucket,
        {
          kind: "slot_text",
          dayId: target.day.lineageId,
          slotId: target.slot.lineageId,
          field: "notes",
          value: merged.value,
        },
        instructions[0],
      );
  }
  for (const assertion of assertions) {
    const bucket = buckets.find((item) =>
      item.targets.some(
        (target) => target.slot.lineageId === assertion.target.slot.lineageId,
      ),
    );
    if (!bucket) continue;
    const conflicts = assertion.ops.some((expected) =>
      bucket.operations.some(
        (op) =>
          op.kind === expected.kind &&
          "slotId" in op &&
          "slotId" in expected &&
          op.slotId === expected.slotId &&
          (!("field" in op) ||
            !("field" in expected) ||
            op.field === expected.field) &&
          JSON.stringify(op) !== JSON.stringify(expected),
      ),
    );
    if (conflicts)
      ask(
        assertion.instruction,
        "A later edit conflicts with the KEEP assertion for this exercise. Choose one intended prescription.",
        bucket,
      );
  }
  for (const constraint of interpreted.constraints) {
    const days = constraint.day
      ? resolveProgramTextDay(current, constraint.day, activeDayId)
      : current.days;
    for (const bucket of buckets) {
      if (
        bucket.operations.some(
          (op) =>
            days.some((day) => day.lineageId === op.dayId) &&
            ((constraint.kind === "groups" && op.kind === "group") ||
              (constraint.kind === "progression" &&
                op.kind === "slot_text" &&
                op.field === "progressionRuleId") ||
              (constraint.kind === "loads" &&
                op.kind === "load" &&
                op.value !== null)),
        )
      )
        bucket.questions.push({
          key: constraint.source,
          source: constraint.source,
          question:
            "This change conflicts with a preservation constraint in your request. Resolve that conflict first.",
        });
    }
  }
  const proposal: ProgramTextProposal = {
    baseDocument: current,
    changes: [],
    questions: [],
    interpretation: {
      version: 1,
      issues: [],
      information: [...new Set(information)],
    },
  };
  for (const bucket of buckets) {
    if (
      bucket.operations.length &&
      !bucket.questions.length &&
      !globalIssues.length
    ) {
      try {
        const built = buildProgramTextProposal(
          current,
          {
            changes: [
              {
                reason: bucket.targets
                  .map(
                    (target) =>
                      `${target.day.name} · ${byId.get(target.slot.exerciseId)?.name}`,
                  )
                  .join("; ")
                  .slice(0, 500),
                sourceQuote: bucket.source.slice(0, 1000),
                operations: bucket.operations,
              },
            ],
            questions: [],
          },
          text,
          [...library],
        );
        const candidate = applyProgramTextChanges(
          current,
          built,
          new Set(built.changes.map((change) => change.id)),
        );
        const violated =
          checkedPreservations.some(
            (request) =>
              parseWorkingTextUpdate(candidate, request, library, activeDayId)
                .questions.length > 0,
          ) ||
          firstPositionAssertions.some(
            (target) =>
              candidate.days.find(
                (day) => day.lineageId === target.day.lineageId,
              )?.exercises[0].lineageId !== target.slot.lineageId,
          );
        if (violated) {
          bucket.questions.push({
            key: [...bucket.keys][0],
            source: bucket.source,
            question:
              "This change conflicts with a KEEP assertion about exercise identity or order. Confirm which instruction should take precedence.",
          });
          proposal.interpretation!.issues.push(...bucket.questions);
          continue;
        }
        proposal.changes.push(
          ...built.changes.map((change) => ({
            ...change,
            instructionKeys: [...bucket.keys],
            warnings: [...new Set(bucket.warnings)],
          })),
        );
      } catch (error) {
        // Expected schema/identity validation is a scoped question; never log
        // authored text, persisted records, or exception payloads.
        if (!(error instanceof Error)) throw error;
        bucket.questions.push({
          key: [...bucket.keys][0],
          source: bucket.source,
          question:
            "These instructions cannot be combined safely with this exercise's groups, identities, or prescription limits. Review this item in the editor.",
        });
      }
    }
    proposal.interpretation!.issues.push(...bucket.questions);
  }
  proposal.interpretation!.issues.push(...globalIssues);
  proposal.interpretation!.issues = [
    ...new Map(
      proposal.interpretation!.issues.map((issue) => [issue.key, issue]),
    ).values(),
  ];
  proposal.questions = proposal.interpretation!.issues.map(
    (issue) => issue.question,
  );
  if (proposal.changes.length > 40 || proposal.questions.length > 20)
    return empty(
      "This request contains too many independent items. Compare one or two days at a time; nothing was applied.",
    );
  // Validate the selected union too, not just each independent item.
  applyProgramTextChanges(
    current,
    proposal,
    new Set(proposal.changes.map((change) => change.id)),
  );
  return proposal;
}
