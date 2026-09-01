# Training Reporting V2 implementation plan

> **Status: historical implementation record.** The Training Reporting V2
> package described here was implemented in public source. This file remains for
> its design rationale and acceptance criteria; it is not current release or
> roadmap authority. Explicit follow-up deferrals remain unimplemented unless
> current source and tests prove otherwise. Current coaching requirements live
> in [`COACHING_PRODUCT_REQUIREMENTS.md`](COACHING_PRODUCT_REQUIREMENTS.md).

## 1. Current reporting and data flow

Completed workout facts live in `workout_sessions`, `session_exercises`,
`session_occurrences`, and `completed_sets`. `buildTrainingDigest` reads those
facts together with pain, fatigue, recommendation, profile, equipment, and
independent-activity records. `renderCoachingBrief` currently turns the digest
directly into Markdown. History reporting has a separate target-outcome
projection. JSON recovery exports retain the canonical tables independently of
the Markdown brief.

The occurrence ledger remains the source of truth. Reporting V2 is a derived,
versioned projection over it; it does not rewrite completed evidence.

## 2. Root causes

- Exercise rows only render calculation-eligible set strings, then use `no
  sets` when that subset is empty even if occurrences prove performance.
- Target percentages lead with the supported subset and do not consistently
  use every planned working occurrence as the coverage denominator.
- Finish currently assigns one generic pending-work reason, so elapsed time,
  voluntary choice, fatigue, pain, equipment, and interruptions become
  indistinguishable.
- Planned duration is not consistently frozen with the session, while current
  profile duration is mutable and therefore cannot interpret history.
- Free-form or narrow skip labels cannot support deterministic recurring-cause
  summaries.
- Every warm-up occurrence is expanded in the main report.
- Coach-facing conclusions and their evidence coverage are not first-class
  structured output.
- Reporting uses exact or mutable family labels inconsistently, while variant
  identity and broad movement-family analysis need different scopes.
- Unilateral repetition/duration counting basis is absent in older records.
- Independent activities record observations, but not a guaranteed sync
  coverage interval.

## 3. Outcome-state model

Use orthogonal facets rather than one overloaded status:

- session completion: completed without a prescription, completed as
  prescribed, completed with changes, completed with remaining work,
  abandoned, or historical unknown;
- occurrence disposition: pending, completed, skipped, substituted through its
  exercise link, ended with the session, legacy unknown;
- performance presence: not performed, performed;
- measurement availability: full, partial, unavailable, not applicable;
- analytical eligibility: eligible, ineligible with an explicit reason,
  unknown;
- cause: time limit, fatigue, pain/discomfort, equipment, user choice,
  technical/app issue, interruption, program change, or historical unknown.

Elapsed duration never selects a causal outcome. A current workout with pending
planned work cannot finish until the owner supplies a reason. Older nulls remain
unknown.

## 4. Exercise summaries

Build each summary from the exercise's occurrences plus retained performed
sets. The reporting states are: not performed; performed with full metrics;
performed with partial metrics; performed with metrics unavailable; skipped;
substituted; session ended before completion; historical outcome unknown.

Set counts and metric completeness are separate. Any proof of performance
forbids the phrase `no sets`. Calculation-ineligible performed facts remain
visible with their exclusion reason.

## 5. Canonical exercise families

Retain the stored exercise variant as the progression identity. Add a
versioned reporting projection for broad movement exposure such as Chest Press,
Squat, Row, Vertical Pull, Hinge, Vertical Press, Curl, Triceps Extension, Calf
Raise, and Core. The projection may aggregate frequency and broad exposure but
must never merge variants for load progression, records, or target decisions.
Unclassifiable legacy items remain `Unclassified` rather than being name-merged.

## 6. Duration adherence

Freeze the planned duration range and its source when a current Program day
becomes a session. Keep the existing active-duration evidence tuple as actual
duration. Calculate variance from the nearest violated bound; use a tolerance
of the greater of five minutes or ten percent of that bound. Report planned,
actual, minute variance, percentage variance, and within/over/under/unknown.
No actual-duration inference is made where active-time evidence is unsupported.

## 7. Coach-summary rules

The top section has five deterministic blocks: training exposure, program
execution, progression, pain, and data confidence. Each statement is emitted
by a named/versioned rule and carries evidence references. Progression text may
only repeat a supported existing rule result; otherwise it says evidence is
insufficient. A dominant incomplete-work cause requires at least two affected
occurrences across two sessions, at least 80% reason coverage, and a leading
cause over 50%.

## 8. Confidence and coverage

Report numerator, denominator, percentage, and tier separately for:

- load/repetition completeness;
- RPE/RIR completeness;
- pain logging availability;
- planned-baseline availability;
- target-outcome eligibility;
- historical-data quality;
- readiness-data availability.

Coverage tiers are none (0%), low (<50%), moderate (50-79.9%), high
(80-94.9%), and very high (>=95%). `Not collected` is distinct from 0%.
Overall target-attainment conclusions require at least 80% coverage, eight
evaluable outcomes, and two sessions. The supported-subset statistic remains
visible even when that conclusion gate fails.

## 9. Legacy data

Classify records as current analyzable Program data, legacy performed history,
legacy unknown outcome, or unsupported comparison data. Do not backfill causes,
planned duration, counting basis, or prescribed baselines from current mutable
metadata. State the earliest current progression baseline supported by retained
prescription evidence. Older facts remain in the audit appendix but are
excluded from unsupported progression conclusions.

## 10. Independent activities

Group observed activities by source. Report source/integration, observed date
range, most recent activity, activity count, latest verified sync receipt when
one exists, and whether exhaustive coverage is known. Manual entry is labelled
manual rather than synced. Until an integration records explicit sync receipts,
the feed is `coverage unknown`, never presented as exhaustive. Independent
activities stay outside strength progression.

## 11. Schema and database changes

Use additive nullable fields for frozen planned-duration semantics, structured
session completion, structured occurrence-resolution reasons, and the bounded
prescribed-counting tuple. Add checks that enforce complete versioned tuples
and immutable current-session meaning. The counting writer stores only
version 1 plus `not_applicable` when Start or accepted compiler evidence proves
a non-unilateral `weight_reps` or `assisted_reps` prescription. Total,
per-side, alternating-total, and hold meaning remain null/unknown because the
current recorder has no durable owner choice for them. Do not update old rows.
Only add sync receipts or broader performed-measurement-basis storage with a
real writer and complete recovery lifecycle.

## 12. Backward compatibility and migration

Apply a new migration; never edit an applied migration. Null tuples mean legacy
unknown. Old finish clients that omit a reason may finish only when no planned
work remains; with pending work they receive an explicit non-mutating error.
Retrying the same retained finish command must preserve the same reason.
Migration `0084_restore_finish_command_receipts` keeps that exact command
identity available after a schema-35 full or history restore, while merging
rather than replacing destination audit history. Bump and test recovery schema
compatibility for every persisted field, including upgrade, restore, and
rollback behavior. Schema 34 upgrades the new counting tuple to null/null
without inference; schema 35 validates and round-trips it.
Keep analysis-package schema 1 strict and exclude these additive reporting
fields from its version-1 source-row hash so unchanged manifests remain valid.

## 13. API and type changes

Add structured completion reason to the finish action and durable client retry
command. Expose reporting facets, coverage objects, duration adherence,
confidence, evidence references, activity source status, and report/rule
versions in the internal report type. Session Start and compiler acceptance
freeze the supported prescribed-counting tuple; readers never derive it from a
later catalog edit. Preserve existing raw backup/CSV contracts unless a
separately versioned addition is made.

## 14. UI and export

When planned work remains, Finish requires an accessible reason selector. The
Markdown hierarchy is Coach summary, compact workout summaries, trend and
confidence analysis, then a detailed audit appendix. Warm-ups collapse by
default; notable exceptions appear in the compact summary. Exact occurrences,
raw results, reasons, notes, and evidence references remain in the appendix.

## 15. Test strategy

Add pure rule tables, database constraint and migration tests, lifecycle retry
and stale-client tests, snapshot/export/restore round trips, report fixtures for
all outcome states, exact coverage-gate tests including 2 of 64, duration
boundaries, reason dominance tests, family/variant separation, ambiguous
unilateral metrics, warm-up exception rules, legacy nulls, activity source
coverage, route authorization/cache headers, accessibility/component tests,
and a representative browser flow. Run focused tests, typecheck, lint, build,
migration replay, broader regressions, and final diff review.

## 16. Edge cases

Cover performed occurrences with archived or absent metric rows; mixed
completed/skipped/pending occurrences; completed-without-result; substitutions
with work logged on the replacement; ad-hoc sets; zero repetitions; duration
unknown after interruption; target ranges; exact tolerance boundaries; only
one session; tied causes; low reason coverage; historical rows with current
catalog conflicts; unclassified exercises; per-side ambiguity; warm-up notes
or pain; empty/stale/manual activity feeds; and retry after reload.

### Owner-evidence addendum: timed activity versus workout duration

A performed set duration and whole-workout active duration are independent
facts. A retrospective exercise can retain an exact distance and set duration
while the session's active-duration tuple remains explicitly unknown. Reporting
must show both facts without copying the set duration into the workout, and no
migration, backfill, correction, or current-catalog inference may reinterpret an
existing record.

The independent-activity table already stores duration in exact seconds, but
the current manual activity form and action accept only whole minutes. Extend
that input additively so new clients can submit exact seconds while cached or
older clients that submit integer minutes remain valid. Reject requests that
supply both representations or neither. This is an API/form compatibility
change only: it adds no column, migration, snapshot field, recovery obligation,
or strength-progression input.

Use a synthetic standalone walking fixture, with values distinct from owner
evidence, to prove that:

- the activity form accepts minute-and-second precision and persists the exact
  seconds;
- distance and pace use that exact duration;
- the independent-activity detail and training brief retain the precise
  duration;
- no workout session is created, so the workout active-duration-unavailable
  warning is absent; and
- an equivalent retrospective workout fixture retains its performed set
  distance/duration while the workout active duration stays unknown and
  excluded from duration analysis.

The retrospective UI should lead a standalone walk, run, or similar dated
activity to **Record activity**. It must also state that a set's duration does
not establish whole-workout active duration. If the entry genuinely represents
a workout, the existing exact-start/optional-workout-duration controls remain
the explicit way to supply session timing; Repbook must not infer it by summing
or selecting set durations in an arbitrary multi-set workout.

The Day Three warm-up complaint is a separate execution-selection problem.
This reporting layer correctly prevents an uncompleted occurrence from becoming
performed evidence, but it cannot prove that the owner declined a warm-up:
`skipped`, `session ended`, and `historical outcome unknown` do not mean
`not selected for this workout`. Do not manufacture a skip or user-choice fact.
The smallest safe follow-up is an explicit workout-level preparation selection
contract that preserves authored Program warm-up intent, records which elements
the owner chose for this session before they can block the upcoming-action
queue, and leaves unchosen elements non-performed without rewriting completed
history. That follow-up requires its own active-workout, retry/reload, session
compiler, History/reporting, snapshot/restore, and mobile-browser acceptance
matrix and is not implemented in this reporting branch.

## 17. Rollout sequence

1. Land pure reporting semantics and focused tests.
2. Land additive lifecycle fields and explicit finish capture.
3. Include the new fields in recovery/export lifecycles and bump schemas.
4. Integrate the deterministic digest and Markdown hierarchy behind the
   existing owner-only export route.
5. Run a fresh-context semantic critic against real fixtures and rendered
   output, then close the largest gaps.
6. Complete regression, migration, browser, documentation, and PR gates.
7. Stop before merge, deployment, production migration, or any historical
   repair pending owner approval.

## 18. Exact acceptance criteria

1. A performed exercise never renders `no sets`, including when its metric row
   is unavailable or analytically ineligible.
2. The report distinguishes planned, performed, measurable, prescribed
   completion, skipped, ended-with-session, substituted, and unknown facets
   without using one as a proxy for another.
3. A 2-of-64 fixture renders 3.1% coverage first, then 2/2 above target, then an
   explicit insufficient-coverage conclusion.
4. Overall attainment language is absent unless coverage is at least 80%, at
   least eight outcomes are evaluable, and at least two sessions contribute.
5. `time_limit_reached` can only come from an explicit owner choice and is
   never inferred from duration.
6. A current workout with pending planned work cannot finish without a
   structured reason; the rejected attempt changes no history.
7. Finish retry/reload persists the exact reason and resolves remaining
   occurrences atomically with that reason.
8. Every completed session with supported duration evidence renders target,
   actual, minute variance, percentage variance, and tolerance status; missing
   evidence renders unknown rather than zero.
9. Period execution reports an average target comparison and only labels a
   dominant incomplete-work cause when the documented dominance gate passes.
10. Equipment, time, fatigue, pain, user choice, substitution, technical issue,
    interruption, program change, and historical unknown remain separately
    countable.
11. Routine warm-ups render one compact completed/planned sentence in the main
    session summary.
12. Retained pain, structured reason, note, or explicit workout-only/change
    evidence makes the relevant warm-up detail visible outside the appendix.
    Unusual load, movement failure, or a downstream prescription change is not
    inferred when the current recorder did not store that fact.
13. The report starts with deterministic Training exposure, Program execution,
    Progression, Pain, and Data confidence blocks.
14. Every coach-summary conclusion exposes a rule version and source evidence
    references; unsupported progression is stated as insufficient evidence.
15. Each major confidence dimension reports its own numerator, denominator,
    percentage/tier, or `not collected`; a generic disclaimer is not the only
    confidence output.
16. Bench-press, squat, and row variants aggregate into their versioned broad
    reporting families while exact variants remain visible.
17. No progression, personal-record, or target calculation combines different
    exercise variants merely because they share a reporting family.
18. Non-load and unilateral results render an explicit measurement unit/basis,
    or state that total-versus-per-side basis is unavailable; they never imply a
    load-based strength calculation.
19. Compact statements can be traced to exact session, exercise, occurrence,
    and performed-set evidence in the audit appendix.
20. The report identifies the current analyzable progression baseline and
    excludes older unsupported comparisons without hiding legacy performance.
21. Independent activity reporting names each source, latest observed date,
    observed range, count, latest sync receipt when available, and whether
    exhaustive coverage is known.
22. Independent activities do not affect automatic strength progression, and
    analysis-package schema 1 remains backward compatible.
23. Additive migration, old-client behavior, backup/export/restore round trips,
    focused semantic tests, broader regressions, build, and representative
    browser verification all pass before the branch is proposed for merge.
24. A synthetic independent activity accepts minute-and-second precision,
    persists exact seconds, renders that precision in its detail/report output,
    and creates no workout-duration warning.
25. The same synthetic measurement recorded as a retrospective performed set
    remains visible while workout active duration stays unknown; no set value is
    promoted, summed, backfilled, or silently reinterpreted as session duration.
26. Current exact-second activity input and legacy whole-minute activity input
    are both accepted, while an ambiguous request containing both is rejected.
27. Retrospective entry visibly directs standalone timed activities to
    **Record activity** and explains that set duration and workout active
    duration are separate facts.
