import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyProgramTextChanges,
  buildProgramTextProposal,
} from "@/lib/program-text-update";
import {
  programUpdateSchema,
  type ProgramUpdateOperation,
} from "@/ai/tasks/program-update/schema";
import { createDefaultProgramSlot } from "@/lib/program-editor-client";
import {
  createSuggestedDayIntent,
  programDocumentV3Schema,
} from "@/lib/program-document";
import { programAIFailureMessage } from "@/lib/program-ai-failure";
const ids = Array.from(
  { length: 20 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
const library = [
  { id: ids[5], name: "Synthetic Press", available: true },
  { id: ids[6], name: "Synthetic Row", available: true },
  { id: ids[7], name: "Unavailable exercise", available: false },
];
function current() {
  const slots = [
    createDefaultProgramSlot(ids[5], ids[3]),
    createDefaultProgramSlot(ids[6], ids[4]),
  ];
  return programDocumentV3Schema.parse({
    schemaVersion: "3",
    programId: ids[0],
    baseVersionId: ids[1],
    name: "Synthetic plan",
    days: [
      {
        lineageId: ids[2],
        name: "Upper",
        notes: "Retain day guidance",
        warmupNotes: "Easy walk",
        warmupItems: [],
        exercises: slots,
        supersets: [],
        intent: createSuggestedDayIntent(slots),
      },
    ],
  });
}
const step = {
  label: "Empty bar",
  reps: 7,
  load: 20,
  loadUnit: "kg" as const,
  loadPercent: null,
  loadText: null,
  notes: "Includes bar",
};
function proposal(
  operations: ProgramUpdateOperation[],
  request = "Update preparation only",
) {
  return buildProgramTextProposal(
    current(),
    {
      changes: [{ reason: "Requested edit", sourceQuote: request, operations }],
      questions: [],
    },
    request,
    library,
  );
}
function apply(p: ReturnType<typeof proposal>) {
  return applyProgramTextChanges(
    current(),
    p,
    new Set(p.changes.map((c) => c.id)),
  );
}
describe("contextual program text edits", () => {
  it("preserves every working field and anchors different ramps to the correct lift", () => {
    const p = proposal([
      {
        kind: "warmup",
        dayId: ids[2],
        slotId: ids[3],
        notes: "Stay easy",
        items: [step, { ...step, reps: 3, load: 30 }],
      },
      {
        kind: "warmup",
        dayId: ids[2],
        slotId: ids[4],
        notes: null,
        items: [{ ...step, reps: 5, load: 25 }],
      },
    ]);
    const before = current();
    const after = apply(p);
    expect(after.days[0].warmupItems.map((x) => x.beforeSlotLineageId)).toEqual(
      [ids[3], ids[3], ids[4]],
    );
    expect(after.days[0].warmupItems.map((x) => x.load)).toEqual([20, 30, 25]);
    for (let i = 0; i < 2; i++)
      expect({
        ...after.days[0].exercises[i],
        warmupNotes: before.days[0].exercises[i].warmupNotes,
      }).toEqual(before.days[0].exercises[i]);
    expect(after.days[0].intent).toEqual(before.days[0].intent);
    expect(after.days[0].notes).toBe(before.days[0].notes);
    expect(after.days[0].warmupNotes).toBe(before.days[0].warmupNotes);
    expect(apply(p)).toEqual(after);
  });
  it("replaces only one warmup scope and preserves other anchors", () => {
    const base = current();
    base.days[0].warmupItems = [
      { ...step, key: ids[10], beforeSlotLineageId: ids[4] },
    ];
    const p = buildProgramTextProposal(
      base,
      {
        changes: [
          {
            reason: "New ramp",
            sourceQuote: "New ramp",
            operations: [
              {
                kind: "warmup",
                dayId: ids[2],
                slotId: ids[3],
                notes: null,
                items: [step],
              },
            ],
          },
        ],
        questions: [],
      },
      "New ramp",
      library,
    );
    const after = applyProgramTextChanges(
      base,
      p,
      new Set(p.changes.map((x) => x.id)),
    );
    expect(after.days[0].warmupItems).toContainEqual(
      base.days[0].warmupItems[0],
    );
  });
  it("does not apply unselected edits or mutate the source", () => {
    const p = proposal([
      {
        kind: "warmup",
        dayId: ids[2],
        slotId: null,
        notes: "New general guidance",
        items: [],
      },
    ]);
    expect(applyProgramTextChanges(current(), p, new Set())).toEqual(current());
    apply(p);
    expect(p.baseDocument).toEqual(current());
  });
  it("rejects unrelated working changes for an explicit warmup-only request", () => {
    expect(() =>
      proposal(
        [
          {
            kind: "load",
            dayId: ids[2],
            slotId: ids[3],
            value: 60,
            unit: "kg",
          },
        ],
        "WARM-UP UPDATE — FUTURE WORKOUTS ONLY",
      ),
    ).toThrow(/preparation-only/);
  });
  it("rejects invented anchors, unavailable replacements and ungrounded quotes", () => {
    expect(() =>
      proposal([
        {
          kind: "warmup",
          dayId: ids[2],
          slotId: ids[19],
          notes: null,
          items: [],
        },
      ]),
    ).toThrow(/exercise/);
    expect(() =>
      proposal(
        [
          {
            kind: "replace",
            dayId: ids[2],
            slotId: ids[3],
            exerciseId: ids[7],
          },
        ],
        "Replace the press",
      ),
    ).toThrow(/unavailable/);
    expect(() =>
      buildProgramTextProposal(
        current(),
        {
          changes: [
            {
              reason: "bad",
              sourceQuote: "Not in request",
              operations: [{ kind: "remove", dayId: ids[2], slotId: ids[3] }],
            },
          ],
          questions: [],
        },
        "Keep everything",
        library,
      ),
    ).toThrow(/traced/);
  });
  it("refuses invalid loading, malformed bounds and stale application", () => {
    expect(() =>
      proposal([
        {
          kind: "warmup",
          dayId: ids[2],
          slotId: ids[3],
          notes: null,
          items: [{ ...step, loadUnit: null }],
        },
      ]),
    ).toThrow();
    expect(() =>
      proposal(
        [
          {
            kind: "slot_number",
            dayId: ids[2],
            slotId: ids[3],
            field: "sets",
            value: 0,
          },
        ],
        "Change sets",
      ),
    ).toThrow();
    const p = proposal([
      { kind: "warmup", dayId: ids[2], slotId: null, notes: null, items: [] },
    ]);
    const changed = current();
    changed.name = "Changed";
    expect(() => applyProgramTextChanges(changed, p, new Set())).toThrow(
      /draft changed/,
    );
  });
  it("changes work targets without touching other fields", () => {
    const p = proposal(
      [{ kind: "reps", dayId: ids[2], slotId: ids[3], min: 6, max: 9 }],
      "Use six to nine repetitions",
    );
    const after = apply(p);
    expect(after.days[0].exercises[0]).toEqual({
      ...current().days[0].exercises[0],
      repMin: 6,
      repMax: 9,
    });
  });
  it("rejects duplicate warm-up scope edits instead of silently choosing one", () => {
    const op = {
      kind: "warmup" as const,
      dayId: ids[2],
      slotId: ids[3],
      notes: null,
      items: [step],
    };
    expect(() => proposal([op, op])).toThrow(/conflicting/);
  });

  it("groups existing exercises with explicit rounds and preserves their load identities", () => {
    const p = proposal(
      [
        {
          kind: "group",
          dayId: ids[2],
          slotIds: [ids[3], ids[4]],
          exerciseIds: [],
          name: "Requested pair",
          rounds: 3,
          restBetweenMembersSec: 15,
          restBetweenRoundsSec: 90,
          restAfterRoundSec: 90,
        },
      ],
      "Pair the press and row for three rounds",
    );
    const after = apply(p);
    expect(after.days[0].supersets[0]).toMatchObject({
      name: "Requested pair",
      plannedRounds: 3,
      restBetweenMembersSec: 15,
    });
    expect(after.days[0].exercises.map((item) => item.lineageId)).toEqual([
      ids[3],
      ids[4],
    ]);
    expect(
      after.days[0].exercises.map((item) => item.groupMemberOrderIdx),
    ).toEqual([0, 1]);
  });

  it("keeps unanswered conditional changes separate", () => {
    const p = buildProgramTextProposal(
      current(),
      { changes: [], questions: ["Adopt the proposed substitution?"] },
      "If adopted, add preparation",
      library,
    );
    expect(p.changes).toEqual([]);
    expect(applyProgramTextChanges(current(), p, new Set())).toEqual(current());
  });
  it("has a provider schema with required properties at every object boundary", () => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const s = value as Record<string, unknown>;
      if (s.type === "object") {
        expect(s.additionalProperties).toBe(false);
        expect(new Set(s.required as string[])).toEqual(
          new Set(Object.keys(s.properties as object)),
        );
      }
      Object.values(s).forEach(visit);
    };
    const schema = z.toJSONSchema(programUpdateSchema);
    expect(JSON.stringify(schema)).not.toContain("oneOf");
    visit(schema);
  });
  it("distinguishes application request errors from transient availability", () => {
    const base = {
      errorKind: "provider_api" as const,
      providerRetryable: false,
      causeKind: null,
    };
    expect(
      programAIFailureMessage({ ...base, providerStatusCode: 400 }),
    ).toContain("do not need to rewrite");
    expect(
      programAIFailureMessage({ ...base, providerStatusCode: 401 }),
    ).toContain("configuration fix");
    expect(
      programAIFailureMessage({ ...base, providerStatusCode: 429 }),
    ).toContain("usage limit");
  });
});
