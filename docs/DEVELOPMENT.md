# Development and verification

## Setup

Use the checked-in npm lockfile and the Node version used by the pull-request
workflow.

```bash
npm ci
cp .env.example .env.local
npm run db:push
npm run db:seed
npm run dev
```

With no `DATABASE_URL`, development uses PGlite. `db:push` is only for local,
disposable data. Existing databases use `npm run db:migrate`.

## Normal application checks

```bash
npm run test
npm run typecheck
npm run lint
npm run build
npm run docs:check
npm run audit:check
```

The migration-free PII-01A Program-intake gate is:

```bash
npx vitest run tests/unit/ai-import-contracts.test.ts tests/unit/routine-import-resilience.test.ts tests/unit/routine-import-stage.test.ts tests/unit/routine-import-confirm-db.test.ts tests/unit/routine-import-component.test.tsx tests/unit/program-text-import-feature.test.ts
npx vitest run tests/unit/program-document.test.ts tests/unit/session-occurrences-data01.test.ts tests/unit/v2-t04-warmup-occurrences-db.test.ts tests/unit/session-compiler-db.test.ts tests/unit/setup-safety-db.test.ts
npx vitest run tests/unit/snapshots-db.test.ts -t "round-trips a current lift-anchored warm-up through snapshot restore"
npm run test:e2e:pii01
```

The focused browser gate owns one fresh disposable database per browser project
so Chromium and mobile WebKit cannot inherit each other's Program rotation or
workout state. It covers a
multi-day paste through reviewed schema-3 publication, 390×844 layout,
keyboard operation, ordered warm-up acknowledgement, a working set, History,
JSON export, enlarged text, ambiguity, and discard. PGlite tests cover malformed
and oversized input, unsupported equipment, exact retry, changed replay, stale
review, unrepresentable per-set rep sequences, atomic publication, snapshot
restore, and both normal and compiled
occurrence order, including distinct between-member and after-round rest. The
native PostgreSQL suite includes the same general/ramp/
working sequence and remains required in CI; it needs a guarded local
`TEST_DATABASE_URL` or explicitly approved ephemeral test branch.

PII-01A changes no SQL migration, snapshot schema, or recovery manifest. Do not
start the owner-specific equipment-incompatibility relation until its additive
migration and complete recovery/export/Coach/alternatives inventory are
separately authorized.

`PROGRAM_TEXT_IMPORT_ENABLED=false` is the server-enforced PII-01A rollback
switch. It removes the Program paste review from the Import page and rejects
new parse and publication Server Actions before any durable write. It does not
remove Hevy History import, discard stored reviews, or downgrade the
anchor-aware Program, editor, workout, export, snapshot, and restore readers.
The variable is enabled when absent; use the exact lowercase value `false` only
on a retained emergency deployment. A pre-PII application build is not a safe
rollback once a PII-01A review may have been staged: its old review path can
drop the new structured warm-up contract before publication, and its old
Program path would silently treat an anchored ramp-up as day-start preparation.

The Repbook v2 semantic foundation and current T01/T02/T03/T04/T05/T06/U01/U02/U03/H01/H02/H03/H04/A01/A02/A03/A04/A05/A06/Gauntlet C/D01/D02 activation
packages have focused gates:

```bash
npx vitest run tests/unit/v2-semantic-contract.test.ts
npx vitest run tests/unit/v2-t01-recording-truth-db.test.ts tests/unit/v2-t01-recording-truth-portability.test.ts tests/unit/v2-t01-recording-truth-restore.test.ts tests/unit/v2-t01-recording-truth-adversarial.test.ts
npm run test:e2e:v2-t01
npx vitest run tests/unit/v2-t02-acknowledgement-correction-db.test.ts tests/unit/v2-t02-acknowledgement-correction-portability.test.ts tests/unit/v2-t02-acknowledgement-correction-restore.test.ts tests/unit/v2-t02-acknowledgement-correction-adversarial.test.ts
npm run test:e2e:v2-t02
npx vitest run tests/unit/v2-t03-planned-order-db.test.ts tests/unit/v2-t03-planned-order-portability.test.ts tests/unit/v2-t03-planned-order-restore.test.ts
npm run test:e2e:v2-t03
npx vitest run tests/unit/v2-t04-warmup-occurrences-db.test.ts tests/unit/v2-t04-warmup-occurrences-portability.test.ts tests/unit/v2-t04-warmup-occurrences-restore.test.ts
npm run test:e2e:v2-t04
npx vitest run tests/unit/v2-t05-execution-semantics-db.test.ts tests/unit/v2-t05-execution-semantics-portability.test.ts tests/unit/v2-t05-execution-semantics-restore.test.ts
npm run test:e2e:v2-t05
npx vitest run tests/unit/v2-t06-preview-start-db.test.ts tests/unit/v2-t06-preview-start-portability.test.ts tests/unit/v2-t06-preview-start-restore.test.ts tests/unit/live-coaching-db.test.ts
npm run test:e2e:v2-t06
npm run test:e2e:v2-u01
npx vitest run tests/unit/v2-u02-exception-context-db.test.ts tests/unit/v2-u02-exception-context-portability.test.ts tests/unit/v2-u02-exception-context-restore.test.ts tests/unit/v2-u02-exception-context-adversarial.test.ts
npm run test:e2e:v2-u02
npx vitest run tests/unit/program-editor-db.test.ts tests/unit/program-editor-component.test.tsx
npm run test:e2e:v2-u03
npx vitest run tests/unit/v2-gauntlet-a-semantic-recovery.test.ts tests/unit/exercise-card-component.test.tsx
npm run test:e2e:v2-gauntlet-a
npx vitest run tests/unit/v2-h01-history-workout-evidence.test.ts tests/unit/live03-pain-substitution-continuity.test.tsx
npm run test:e2e:v2-h01
npx vitest run tests/unit/v2-h02-cadence-targets-time-db.test.ts tests/unit/v2-h02-cadence-targets-time-portability.test.ts tests/unit/v2-h02-cadence-targets-time-restore.test.ts tests/unit/v2-h02-cadence-targets-time-adversarial.test.ts
npm run test:e2e:v2-h02
npx vitest run tests/unit/v2-h03-evidence-identity-db.test.ts tests/unit/v2-h03-evidence-identity-portability.test.ts tests/unit/v2-h03-evidence-identity-restore.test.ts tests/unit/v2-h03-evidence-identity-adversarial.test.ts
npm run test:e2e:v2-h03
npx vitest run tests/unit/v2-h04-pain-consistency.test.ts tests/unit/v2-h04-pain-consistency-db.test.ts tests/unit/v2-u02-exception-context-adversarial.test.ts tests/unit/v2-u02-exception-context-portability.test.ts tests/unit/v2-u02-exception-context-restore.test.ts
npm run test:e2e:v2-h04
npx vitest run tests/unit/analysis-package-db.test.ts tests/unit/recovery-manifest-db.test.ts --maxWorkers=1 --no-file-parallelism
npm run test:e2e:v2-a01
npx vitest run tests/unit/v2-a02-external-ai-instructions.test.ts
npm run test:e2e:v2-a02
npx vitest run tests/unit/v2-a03-external-analysis-response.test.ts
npm run test:e2e:v2-a03
npx vitest run tests/unit/v2-a04-external-analysis-validation.test.ts --maxWorkers=1 --no-file-parallelism
npm run test:e2e:v2-a04
npx vitest run tests/unit/v2-a05-selective-review-bridge.test.ts --maxWorkers=1 --no-file-parallelism
npm run test:e2e:v2-a05
npx vitest run tests/unit/v2-a06-adversarial-corpus.test.ts --maxWorkers=1 --no-file-parallelism
npx vitest run tests/unit/v2-gauntlet-c-external-roundtrip.test.ts tests/unit/v2-a06-adversarial-corpus.test.ts --maxWorkers=1 --no-file-parallelism
npx vitest run tests/unit/server-log.test.ts tests/unit/ai-provider-error.test.ts tests/unit/v2-d01-structured-diagnostics.test.ts --maxWorkers=1 --no-file-parallelism
npx vitest run tests/unit/v2-d02-support-bundle.test.ts --maxWorkers=1 --no-file-parallelism
```

The migration-free product-polish hierarchy gate is:

```bash
npx vitest run tests/unit/workout-summary.test.ts tests/unit/today-lineage-db.test.ts tests/unit/live03-pain-substitution-continuity.test.tsx --maxWorkers=1 --no-file-parallelism
npx playwright test tests/e2e/workout-smoke.spec.ts -g "makes Today one decisive|keeps the no-history|confirms one complete quick log"
npm run test:e2e:v2-h01
npm run test:e2e:v2-h02
npm run test:e2e:v2-t04
npx playwright test --config=playwright.phase2.config.ts
```

It proves the reduced Today query budget and one-primary-action hierarchy,
explicit warm-up opt-in, deterministic completed-workout summary, truthful
unknown and provenance states, stable deep links into the closed technical
record, contextual note entry and offline recovery, and desktop plus narrow
mobile behavior. It adds no schema, migration, historical rewrite, calculation
formula, Coach decision, import, export, or authentication change.

The deterministic ambient-intelligence gate is:

```bash
npx vitest run tests/unit/athlete-insights.test.ts tests/unit/previous-comparable-sets-db.test.ts tests/unit/workout-summary.test.ts tests/unit/exercise-card-component.test.tsx --maxWorkers=1 --no-file-parallelism
npx playwright test tests/e2e/workout-smoke.spec.ts -g "makes Today one decisive|keeps the no-history Today|shows one ambient insight|signs in and completes"
npm run test:e2e:v2-h01
```

It proves deterministic candidate identity and ranking, supported pending
decision containment, exact recent-best matching, the four-set/two-workout rest
threshold, completed-workout comparison, and conservative suppression for
mixed units, legacy evidence, imports, pain or limitation context, sparse
records, and absent history. Browser verification must also prove that Today
shows at most one signal, the active signal appears once at exercise level,
**Explain** prefills but does not send Live Coach, and post-workout evidence is
available under **How calculated**. This tranche adds no schema, migration,
historical rewrite, recommendation, decision, Program write, automatic AI call,
external analytics payload, import, export, or authentication change.

The semantic test validates all synthetic F01-F17 scenarios and every required
verification-matrix cell; by itself it proves contract consistency only. The
T01 tests activate the mapped database, browser, portability, recovery, and
adversarial claims for truthful performed measurement. T02 activates the same
evidence classes for acknowledgement, retry, and reviewed correction, including
correction-lineage restore. T03 activates planned-order, extra-before/after-plan,
group ordering, History/Review/export, and recovery evidence. T04 activates
default warm-up suppression at Today Start, explicit opt-in bound to Start
identity, one action per included authored warm-up, retained Program snapshots,
reversible acknowledgements, aggregate exercise-decision safety, portability,
recovery, and desktop/mobile browser evidence. T05 activates
acknowledgement-ordered current/next guidance,
source-bound durable rest described by its next destination, direct
ready-to-finish when the final actionable set is queued, group/member/round
mixed-resolution state, and a discoverable bulk Finish-early path that closes
remaining planned work under one explicit reason without requiring individual
skips. Confirmed exercise-skip replacement remains optional while uncertain
recorded work still fails closed. T05 retains portability, recovery, and
desktop/mobile browser evidence. T06 activates read-only preview, one canonical
owner-scoped Start intent across retries, truthful active-workout collision
outcomes, and immutable prescribed exercise meaning across active display,
History/Review, export, snapshot schema 28, and restore. U01 activates the
current-first active-workout hierarchy, one ordinary commit action, progressive
disclosure, exact acknowledgement visibility, 44-pixel reachable controls, and
overflow checks on desktop, 440×956 mobile, and 320×700 mobile. U02 activates
exception-only effort, technique, limitation, note, and set-linked pain capture;
offline retry identity; History and Review visibility; snapshot schema 29; and
restore with explicit unknowns for schema 28. U03 activates exact future-only
draft, review, publication, failure-recovery, and active-session/History/version
isolation without a schema or recovery-manifest change. Gauntlet A reruns the
complete real-workout scenario bar at desktop, 440×956 mobile, and 320×700
enlarged-text mobile references. It includes exact offline and
timeout-after-commit retry, bodyweight substitution, abandoned-session export,
keyboard-selected-state, touch-target, overflow, and page-error oracles.
H01 then activates performed-first completed and imported workout detail: only
linked acknowledged working-set occurrences enter the performed count,
structured warm-ups stay separate, plan and retained source rows remain
inspectable, and terminal, provenance, correction, performed-meaning, and
calculation-eligibility facets stay explicit. Its dedicated fresh fixture proves
desktop and narrow enlarged-text mobile behavior, active-session redirect,
keyboard and touch access, zero overflow, and no post-login mutation.
H02 activates versioned calendar cadence and planned-set outcome calculations.
Only complete Monday-to-Sunday weeks enter the weekly cadence average; gaps use
retained workout-local calendar dates, and Program-day exposure uses stable day
lineage while retaining historical labels. Below, at, above, and unknown
outcomes are recomputed from acknowledged performed evidence and the exact
frozen occurrence target. Unsupported, percentage, text, missing, or ambiguous
targets remain unknown. The current weekly preference is shown only as a
comparison and never as an adherence claim. Corrections and restores recompute
current outcomes without editing Program intent or trusting the legacy stored
target projection. The dedicated disposable browser fixture proves these
distinctions on desktop and narrow enlarged-text mobile with no post-login
mutation.
H03 activates exact performed exercise identity, owner scope, reviewed source
mapping, and evidence tiers across History, CSV, and recovery. Only one exact
linked completed working-set occurrence can enter exercise calculations; Hevy
evidence additionally requires the current owner's source-scoped mapping to the
same performed exercise. Missing mappings remain legacy, mismatches remain
unsupported, and the frozen source occurrence key stays separate from the
reviewed mapping and its confirmation provenance. Substitutions keep prescribed
and performed IDs separate, and derived progression is labelled with
`exercise-history-v1`. URL-backed filters and source-workout returns preserve
context, while cross-owner identities fail closed. The dedicated disposable
browser fixture verifies desktop and narrow enlarged-text mobile behavior with
no post-login mutation.
H04 activates `pain-evidence-v1` across active workout, History, Review, Coach
context, proposal-only pain holds, CSV, and snapshot restore. No record stays
unknown, valid general severity zero is explicit no-issue evidence, positive
supported records are pain evidence, and unsupported shapes are retained but
excluded from conclusions. Positive `set_exception` evidence can now inform a
reviewable hold or progression proposal without changing Program intent,
approving a decision, or creating an adaptation. Exact performed/planned
substitution identity travels with exported and Review evidence. The dedicated
desktop and independent narrow enlarged-text mobile fixtures verify optional
zero capture, positive/no-issue History, distinct technique and limitation
context, Review visibility, zero post-login mutation, overflow, and page-error
boundaries.
Gauntlet B adds a complete live-workout regression over the real warm-up,
ordinary set, equipment-driven skip, deliberate continuation, replacement, and
finish journey. It runs against independent disposable desktop, tall-phone, and
320 by 700 WebKit fixtures at 145% text and enforces a minimum usable viewport,
44-pixel recovery targets, no horizontal overflow, and no unexpected page
errors. Recovery manifest 11 also makes History-only restore monotonic for
owner decisions and accepted adaptations: it cannot downgrade a later terminal
recommendation or resurrect an older pending proposal. Snapshot schema 30 and
the durable table inventory are unchanged. A01 activates a complete,
purpose-bounded, versioned owner export, a canonical digest, exact
preview/download bytes, privacy-minimal owner-scoped manifests, physical owner
deletion, explicit omissions, and separated fact, calculation, recommendation,
decision, and adaptation domains. Its desktop and independent 320 by 700
WebKit journey at 145% text proves no external request, exact download equality,
owner deletion, accessibility, and no horizontal overflow. Migration 0075 adds
only the manifest receipt; recovery manifest 12 excludes that operational
receipt from snapshot schema 30 and restore, while the existing privacy-
retention job physically removes expired receipts.
A02 activates deterministic provider-neutral instructions bound to that exact
package and digest. Its two synthetic workflow oracles require evidence-linked
observations, explicit limitations, preserved unknowns, no embedded-instruction
execution, no guessed fact, and no mutation claim. The dedicated desktop and
narrow enlarged-text browser proof downloads the exact instruction bytes and
confirms that preparing them makes no external request.
A03 activates closed `analysis-response/1` instructions and validation in
`src/lib/external-analysis-response.ts`. Focused contract tests reject extra
fields, incompatible versions, stale or contradictory package binding,
unsupported units, unknown evidence, duplicate IDs, prohibited or unknown
effects, oversized content, and conflicting response replay. The dedicated
desktop and narrow WebKit journey proves the exact downloaded instructions bind
the current package and describe the strict future-review-only response shape.
A03 adds no import UI, durable response, migration, recommendation, decision,
adaptation, or Program write.
A04 activates the transient untrusted-input boundary. Raw response bytes, JSON
media and UTF-8, nesting depth, active or display-unsafe text, the owner-scoped
manifest, expiry, exact Program/version precondition, closed A03 bindings,
evidence IDs, units, and effects all fail closed before preview. Desktop and
independent narrow WebKit journeys exercise paste and file paths, exact
plain-text preview, active-content refusal, untouched local recovery download,
discard, accessibility, and overflow. Validation retains and imports nothing,
adds no migration or snapshot shape, and creates no recommendation, decision,
adaptation, or Program write.
A05 activates explicit selective import into the existing Review lifecycle.
Focused database proof covers owner scope, exact replay and conflict identity,
atomic rollback, manifest consumption, durable defer, resume, reject, edit-and-
accept, closed-source freshness before and during import, stale historical
observations after later correction, snapshot privacy, and restore graph
validation. Its disposable desktop and narrow WebKit journey imports one
observation and one proposal, preserves external labels and owner-decision copy,
exercises acceptance or deferral, and checks overflow and page errors.
Migration 0076 adds receipt identity and invariant guards. Migration 0077 adds
the external-receipt-aware restore race check required by the existing privacy
normalization. Migration 0078 adds the owner evidence epoch that closes new-row
and collection-membership races across the source inventory. Snapshot schema 30 stays fixed while recovery manifest 13
includes the durable provenance relationship. Acceptance records a future Review direction with
`programChanged: false`; it does not publish a Program or rewrite history.
A06 activates the synthetic provider-neutral adversarial corpus without adding
a browser or runtime path. Its exact raw, response, and stateful import oracles
cover valid, partial, stale, hallucinated, prompt-injected, oversized, deeply
nested, duplicate, conflicting, cross-user, unknown-exercise, wrong-unit,
unsupported-legacy, mixed-version, unknown-field, and unknown-effect cases.
Valid import is limited to the expected external Review records and Review
revision transition. Every rejection, recovery, and replay oracle proves
Program intent, immutable Program versions, active work, and performed facts do
not change; stateful failures also preserve the complete import state.

Gauntlet C runs two independently produced synthetic responses through the real
package, instruction, hostile-input parsing, owner-manifest validation,
selective Review import, and explicit approval path. It requires the complete
validated object to remain inspectable before import, both workflows to produce
evidence-linked future-only proposals useful enough for explicit acceptance,
and protected Program, active-workout, and performed-fact state to remain
unchanged. Its A06 unknown-effect case must reject deterministically and permit
validation of the corrected response without consuming the manifest or writing
Review state.

D01 activates the single structured diagnostic boundary. Its focused gate
proves exact event and field allowlists, fail-closed unknown input, sanitized
provider and ordinary error categories, random episode-scoped correlation,
declared retention expiry, output-failure isolation, and source-wide omission
of owner IDs, record IDs, workout content, raw errors, tokens, and provider
payloads. D01 changes no browser path or persisted application state, so it
does not add a dedicated browser or database gate.

D02 activates the separate `support-bundle/1` and `support-redaction/1`
boundary at `/export/support`. Its focused contract proof covers the four
problem-specific coarse-context allowlists, random per-bundle correlation,
populated, empty, and collection-error bundles, optional-section removal,
bounded deliberate owner text, exact serialization, and static absence of
upload, persistence, retained-log, or AI-analysis paths. The dedicated desktop
and 320 by 700 WebKit journey proves the exact preview/download bytes, local-
only request boundary, keyboard access, and no horizontal overflow. D02 adds no
database, migration, snapshot, recovery-manifest, provider, Program, workout,
or performed-fact change.

The post-v2 active-workout tranche adds interruption-aware completion and
stale-session recovery without rewriting source timestamps. Migration 0079
stores reviewed active-duration evidence separately; snapshot schema 31
round-trips it and upgrades schema 30 rows to null evidence. Recovery manifest
14 keeps the same durable-table inventory and restores an active-duration
correction together with its linked version and audit evidence. Legacy or
explicitly unknown active time remains unavailable to duration analytics. The
logging point now projects existing lifecycle state through the pure
`ActiveWorkoutViewModel`; that projection is not another store. One cockpit
owns exact, semantically compatible previous-set evidence, performed inputs,
and the ordinary Log set action. The fixed status bar omits that action while
the cockpit is revealed and offers a neutral return after collapse. At 390 by
844 and 320 by 700 with enlarged text, normal rest replaces set editing, the
exercise queue retains ledger order, and secondary tools remain in one
keyboard-accessible native disclosure without hiding pending writes, retry,
skipped recovery, finish, or saved-set correction.

The Day One recovery follow-up bounds every recorded-work acknowledgement that
owns active-workout progress. A never-answering set, equipment, occurrence,
skip reconciliation, extra-set, or Finish action must retain the exact command,
release local queue ownership, require a document reload, and replay
idempotently. Finish must also wait for recovery-marker hydration and must not
bypass unreadable recorded-work storage. Focused recovery verification lives in
the deployment-recovery and set/equipment/occurrence outbox tests plus
`session-runner-exit` and `exercise-card-component`.

The same follow-up keeps acknowledged warm-ups and sets in closed disclosures,
places correction with the saved set, reveals the next current set immediately
after an exact device-durable enqueue, and shows exercise setup above its work
only while a choice, change, ambiguity, queued equipment action, or safety issue
needs attention. It compacts mobile
superset context, and prevents the fixed timer controls from overlapping at
intermediate phone widths. New-device rest alerts default to foreground sound;
the timer exposes the effective mode and the set-log gesture primes Web Audio.
Sound-enabled timers tick locally from 10 through 1 and then play the same
stronger finish alarm exposed by the Settings test control.

### Product Polish Package 1 interaction contract

Set logging now separates short local outbox mutation from owner-scoped network
delivery. The local command must be durable before the active-workout projection
advances, but a delayed Server Action must not block a second enqueue, retry, or
deliberate discard. Web Locks provide cross-tab single-flight delivery for the
combined equipment/set stream. Browsers without that guarantee keep the exact
device copies, make no delivery attempt, disable retry, and show **Saving
paused** with recovery guidance.

Rest-timer reconciliation begins only after that durable enqueue and retains its
own cross-tab ordering contract, but it is not awaited by the athlete-facing UI
advance. Storage failure still produces an explicit timer warning while the set
continues saving from its retained device copy.

The latest acknowledged explicit rest outcome is retained temporarily under
`workout-tracker:workout-rest-intent-receipts:v1`. It is a bounded local-only
ordering receipt, not workout history: it contains no exercise, load,
repetition, pain, or note content. Older retries must defer to later retained or
acknowledged rest outcomes across backoff, tabs, and reload. Removing the final
relevant set prunes the receipt atomically; a receipt-write failure restores the
exact pre-removal device bytes and reports failure. Active-workout abandonment
and owner cleanup follow the same fail-closed rule.

Start uses the existing replay-safe request key while native form pending state
provides a disabled, busy **Starting workout…** control and polite confirmation
message. Content-free Performance API marks cover Start submit/pending, cockpit
usability, set tap/local retention/UI advance/acknowledgement, and rendered
recovery. They are for tests and local diagnostics only and carry no athlete
payload. The set UI-advance mark is emitted from the committed local projection
in a layout effect, rather than from a scheduler-sensitive animation frame.

The focused Package 1 gate is:

```bash
npx vitest run tests/unit/workout-set-outbox.test.ts tests/unit/workout-set-outbox-lock.test.ts tests/unit/workout-set-outbox-sync.test.ts tests/unit/equipment-selection-outbox-sync.test.ts tests/unit/active-workout-discard.test.ts tests/unit/workout-interaction-performance.test.ts tests/unit/workout-start-form-contract.test.ts
npm run test:e2e:v2-t02
npm run test:e2e:v2-t05
npm run test:e2e:v2-t06
npm run test:e2e:v2-gauntlet-a
```

T02 deliberately holds the first acknowledgement while a second set reaches
local retention and UI advance, with both measured under 100 ms. T05 covers the
older-command-backoff, later terminal acknowledgement, older replay, second-tab,
and reload sequence. T06 measures truthful Start pending feedback under 100 ms
while preserving one request identity.

Day 2 reliability coverage adds absolute-deadline restore and missed-expiry cue
tests, Wake Lock rejection/release/race tests, slow and failed set-outbox
projection tests, duplicate Program-import rejection, preparation-set ordering,
equipment-geometry switching, workout-only removal/undo semantics, and narrow
active-title rendering. The timer must be reconciled on visibility, pageshow,
focus, and runner rehydration; no test may treat interval execution as elapsed
time truth.
The Day One active-workout regression gate is:

```bash
npx vitest run tests/unit/session-occurrences-data01.test.ts tests/unit/session-guidance.test.ts tests/unit/session-lifecycle-characterization.test.ts tests/unit/v2-t04-warmup-occurrences-db.test.ts tests/unit/exercise-card-component.test.tsx tests/unit/session-actions-results.test.ts tests/unit/progression.test.ts tests/unit/progression-performed-baseline-db.test.ts tests/unit/session-equipment-requirements.test.ts tests/unit/equipment-inventory-contract.test.ts
npm run test:e2e:v2-t04
npm run test:e2e:superset-prep
npm run test:e2e:active-workout-add-exercise
npm run test:e2e:plate-machine-guidance
npm run test:e2e:current-action
```

It covers the one-tap time skip and detailed alternative, strict warm-up and
rest order, prior-load precedence and remount hydration, explicit future-only
progression evidence, saved dumbbell increment merging, pre-start equipment
attention, local cable/plate guidance, superset visibility, stable workout-only
remove/Undo, offline retained work, reload, duplicate taps, reduced motion,
keyboard access, and the 390 by 844 and 320 by 700 mobile layouts. This tranche
adds no migration and does not change snapshot or recovery-manifest versions.
An offline warm-up decision is durably retained and replayed, but progression
past that action waits for server acknowledgement; this is recovery, not a
claim that the complete workout can advance offline.
An installed-iPhone PWA field check remains required before release because
automated WebKit cannot establish device sound, silent-mode, Bluetooth, or
background behavior.

### Active Workout North Star Phase 0 contract gate

Phase 0 characterizes the current implementation before the compact-ledger UI
work begins. Its focused gate is:

```bash
npx vitest run tests/unit/active-workout-phase0-contract.test.ts tests/unit/workout-set-outbox-sync.test.ts
npm run build
npm run test:e2e:active-workout-north-star
```

The browser suite records the current seven-state comparison baseline using
disposable synthetic data and keeps the known post-log Enter mutation as an
expected failure. An unexpected pass is intentional CI pressure to remove the
annotation when the focus fix lands. The isolated equipment-decision scenario
uses an environment-only two-bar fixture and never changes ordinary seed data.
Phase 0 changes no application writer, schema, migration, history, or
production data.

### Active Workout North Star Phase 1 compact-ledger gate

Phase 1 replaces the isolated current-set cockpit with one projection-backed
set ledger. Its focused gate is:

```bash
npx vitest run tests/unit/active-set-ledger-component.test.tsx tests/unit/exercise-card-component.test.tsx
npm run build
npm run test:e2e:active-workout-north-star
npm run test:e2e:v2-u01
npm run test:e2e:v2-t01
npm run test:e2e:v2-t02
```

Completed, current, future, extra, skipped, retained, failed, corrected,
restored, and unknown rows all come from the immutable occurrence projection.
The current row reuses the existing performed-value controls and command
handlers; there is no new writer or persistence path. The Phase 0 post-log
Enter test remains an expected failure until Phase 2 owns the focus handoff,
and normal rest continues to replace set editing until Phase 3. Phase 1 adds no
schema, migration, snapshot, recovery-manifest, import/export, or production-
data change.

### Day 2 active-workout reliability root causes

The August 16, 2026 candidate confirmed these causes before remediation:

- The timer already retained an absolute end time, but set acknowledgement—not
  the Log set gesture—created it. Resume could mark an elapsed timer as missed
  without attempting one idempotent final cue, focus was not a reconciliation
  event, and no Screen Wake Lock lifecycle existed.
- Set commands already had stable client IDs and durable retry storage, but the
  client projection deliberately kept the same occurrence current until the
  database acknowledged it. That policy made normal latency look like a frozen
  workout.
- Snapshot construction now orders general warm-ups first, then every
  lift-linked ramp in Program order, then all working sets. The occurrence-order
  tests are the authority against reintroducing a mid-workout preparation
  blocker. Sessions created before this change keep their frozen occurrence
  sequence.
- Routine import allowed two slots in one day to resolve to the same stable
  exercise ID. Snapshot creation and rendering preserve distinct stable rows;
  the missing duplicate guard was at the import review and confirmation trust
  boundary.
- Plate and pin guidance already derives from the selected equipment geometry,
  not the exercise display name. Plate-loaded guidance is unavailable when the
  active snapshot is selectorized or lacks known machine geometry; the engine
  must not invent starting resistance, loading points, compatible plates, or a
  pulley ratio. No private production owner record was inspected for this
  candidate.
- Previous comparable evidence was already stable-ID and performed-semantics
  scoped, but it appeared only deeper in the set card. The active headline did
  not expose that verified context, and header layout still allowed surrounding
  controls to constrain long exercise names.

Physical iPhone acceptance must keep normal Auto-Lock enabled and check several
consecutive timers across backgrounding and manual lock/reopen, with Low Power
Mode both off and on. Confirm immediate next-set/rest presentation, accurate
deadline reconciliation, no burst of missed ticks, one resumed expiry alarm at
most, correct plate-loaded Triceps Pushdown guidance, visible preparation-set
order, remove/Undo semantics, preserved routine/history, and full portrait title
wrapping. Manual lock may suspend the PWA; neither Web Audio nor Wake Lock
guarantees a lock-screen alarm.

An exact retained set command may reconcile after its workout becomes terminal
only when the owner-scoped saved row and the complete performed evidence match.
Changed identity reuse still conflicts and a new terminal-workout set remains
rejected. The T02 database gate and H01 browser fixture cover the no-duplicate
replay and automatic device-copy removal paths.

The retained equipment-preparation tranche adds migration 0080 and snapshot
schema 32 without backfilling older workouts. Start, Session Compiler
acceptance, workout-only add, substitution, version restore, snapshot capture,
and snapshot restore must keep the `session_exercises` requirement tuple
complete and exercise-identity matched. Focused tests must cover stable-ID
deduplication, same-label/different-identity evidence, legacy and malformed
unknowns, owner scope, saved-inventory and exact attachment/geometry
availability, contradictory same-type and broad-versus-exact identities,
truthful missing-versus-saved-but-incompatible row and aggregate copy,
history-revision and inventory-evidence races, retained-only
setup/log validation, and schema 31 upgrade plus restore omission. Recovery
manifest 14 and the durable
table count stay unchanged.

Broad saved-equipment presence and exact executability remain distinct: a
saved cable station with incomplete reviewed geometry is incompatible, never
unavailable. Ambiguous imported loading-family names require an explicit
stable-ID choice, while explicit cable and plate-loaded names stay
deterministic. Existing active and completed sessions are not remapped.

The adaptive schedule foundation adds migration 0081, snapshot schema 33,
recovery manifest 15, and three owner-scoped tables. It does not backfill or
synthesize schedules for existing Programs, so routine-only Today and Start
remain unchanged. Schedule publication and missed-day adjustments are
idempotent, owner-scoped operations; scheduled resistance Start freezes a
self-contained schedule snapshot while cardio, recovery, and rest remain
separate event types. A schedule replacement is accepted only while every
current occurrence is untouched; any started, resolved, or adjusted occurrence
makes publication fail without changing the schedule.

The named Program and tracker-facing schedule slice adds migration 0082 and
snapshot schema 34 without adding another table or changing recovery manifest
15. `active` and `inactive` are both usable, versioned Programs; the database
still permits only one active Program per owner. `/program/library` owns
explicit switching and `/program/schedule` intentionally authors only one
simple fixed or rolling phase. Advanced schedule documents remain read-only in
that editor. Today uses the current scheduled occurrence when one exists,
passes its exact version, hash, event, and revision into resistance Start, and
keeps cardio, recovery, and rest as non-resistance events. Alternate routines
remain preview-only while a schedule exists. Program switching and workout
Start share an owner-profile compare-and-swap mutex, and schema-34 restore
rejects a usable Program library with no active Program. Parser internals and
canonical routine syntax are unchanged.

Training reporting V2 adds migrations 0083 and 0084 plus snapshot schema 35
without adding a durable table or changing recovery manifest 15. Migration 0083
adds the reporting lifecycle tuples; migration 0084 preserves the exact durable
Finish-command receipt through guarded full/history restore. The feature requires explicit
remaining-work reasons, freezes supported Program duration/counting meaning,
keeps old nulls unknown, and makes the Coach brief and History target coverage
use the full planned-outcome denominator. Its focused gate is:

```bash
npx vitest run tests/unit/training-report.test.ts tests/unit/reporting-exercise-family.test.ts tests/unit/training-report-digest-db.test.ts
npx vitest run tests/unit/reporting-session-outcomes-db.test.ts tests/unit/session-lifecycle-characterization.test.ts tests/unit/session-runner-exit.test.ts tests/unit/occurrence-mutation-dialog.test.tsx
npx vitest run tests/unit/history-report.test.ts tests/unit/history-calendar.test.tsx tests/unit/v2-h01-history-workout-evidence.test.ts tests/unit/v2-h02-cadence-targets-time-db.test.ts
npx vitest run tests/unit/snapshots-db.test.ts tests/unit/analysis-package-db.test.ts tests/unit/recovery-manifest-db.test.ts --maxWorkers=1 --no-file-parallelism
npx vitest run tests/unit/activities.test.ts tests/unit/retrospective-workout.test.ts tests/unit/training-report-digest-db.test.ts --maxWorkers=1 --no-file-parallelism
npm run db:verify
npm run db:verify-production-upgrade
```

The native two-connection finish and occurrence-retry races require a guarded,
disposable `TEST_DATABASE_URL`; they must run in protected PostgreSQL CI when
that variable is unavailable locally. The representative workout smoke journey
at mobile width proves that Finish remains disabled until an explicit reason is
selected and that the structured reason is visible in saved History. Run that
focused Playwright test before the broader browser inventory.

The owner-evidence activity acceptance uses synthetic distance and duration
values. `test:e2e:history-calendar` proves that retrospective entry directs a
standalone timed activity to **Record activity**, that minute-and-second input
uses separate digit-only mobile fields, round-trips exactly on activity detail,
and that the independent activity does
not receive a workout active-duration warning. The retrospective service test
separately proves that an exact performed-set duration does not become workout
active duration.

The download-workspace acceptance keeps the Complete AI report, bounded
Training Brief, and full backup visible before the closed Advanced exports
section on desktop and narrow WebKit. It verifies that the primary action reads
all available non-archived training evidence, prepends the provider-neutral
prompt, copies the exact private no-store response only after a user tap, and
makes no external request. It also verifies that History carries bounded period
context into the separate brief selector, shows an explicit 12-week default for
all-time History, and retains the distinct CSV, analysis-package,
support-bundle, and canonical JSON paths. The A01 browser gate separately proves
that Copy JSON matches the visible package bytes exactly.

Run the focused named Program and tracker schedule contract with:

```bash
npx vitest run tests/unit/named-program-library-migration.test.ts tests/unit/program-library-db.test.ts tests/unit/program-schedules-db.test.ts tests/unit/program-scheduled-start-db.test.ts tests/unit/start-session-route-freshness.test.ts tests/unit/recovery-manifest-db.test.ts
```

Run the focused schedule contract with:

```bash
npx vitest run tests/unit/program-schedule.test.ts tests/unit/program-schedules-db.test.ts tests/unit/program-scheduled-start-db.test.ts tests/unit/program-schedule-restore-db.test.ts
```

`test:e2e:superset-prep` owns the 390 by 844 default-text and 320 by 700
enlarged-text preparation journey, including current-action-first DOM order,
keyboard focus, target size, overflow, pre/post-acknowledgement reload, and
screenshots. `test:e2e:replacement-mobile` proves a substitution cannot leave
old requirements visible, while `test:e2e:active-workout-add-exercise` proves
a bodyweight addition does not fabricate equipment. Exact exercise setup and
retry remain covered by their established local-equipment suites. Automated
WebKit is required but does not replace an installed-iPhone PWA and VoiceOver
field check before release.

`audit:check` requires a clean production dependency audit and also reviews the
complete development-tool tree. Any temporary development-only exception is
bound to exact lockfile nodes, carries a written reason and expiry date, and
cannot exempt a production dependency finding.

## Persisted-data checks

```bash
npm run db:verify
npm run db:verify-production-upgrade
npm run test:integration:postgres
```

`test:integration:postgres` requires a disposable PostgreSQL database through
`TEST_DATABASE_URL`. Never point test commands at production.

## Browser checks

```bash
npm run test:e2e
npm run test:e2e:pain-hold
npm run test:e2e:history-calendar
npm run test:e2e:history-workspace
npm run test:e2e:program-editor
npm run test:e2e:program-editor-cross-browser
npm run test:e2e:current-action
npm run test:e2e:superset-prep
npm run test:e2e:active-workout-north-star
npm run test:e2e:v2-t06
npm run test:e2e:v2-u01
npm run test:e2e:post-v2-p1-timing
npm run test:e2e:v2-u02
npm run test:e2e:v2-u03
npm run test:e2e:v2-gauntlet-a
npm run test:e2e:v2-h01
npm run test:e2e:v2-h02
npm run test:e2e:v2-h03
npm run test:e2e:v2-h04
npm run test:e2e:v2-h05
npm run test:e2e:v2-gauntlet-b
npm run test:e2e:v2-a01
npm run test:e2e:v2-a02
npm run test:e2e:v2-a03
npm run test:e2e:v2-a04
npm run test:e2e:v2-a05
npm run test:e2e:v2-d02
npm run test:e2e:v2-r01
```

The general workout smoke suite owns the Review decision hierarchy, the concise
empty Review state at 390 by 844, and disclosure access at narrow enlarged text.
`test:e2e:history-workspace` owns the three History destinations and
conclusion-before-evidence hierarchy. `test:e2e:history-calendar` owns the
single supported action signal above the calendar and proves that History never
renders more than one such signal. Focused unit coverage for that deterministic
selection lives in `tests/unit/history-calendar-workspace.test.ts`.

Run the smallest affected browser suite first, then the complete protected
workflow for a merge candidate. Protected CI runs the authoritative inventory
in `scripts/production-browser-groups.json` as six balanced parallel groups;
`verify` remains a fail-closed collector over PostgreSQL, the complete
automated/static/build core, and every browser group. Validate registry and
workflow alignment with `npm run ci:browser-groups:check`. The Stage 5 timer
suite receives an unused run identity from the group runner. All browser
fixtures must remain synthetic.

R01 lifecycle verification is split across
`tests/unit/v2-r01-lifecycle-audit-db.test.ts`, portability, restore, and
adversarial omission tests plus the dedicated browser journey. The database
test uses a disposable fully migrated database and must continue to match the
68-table recovery manifest exactly. The browser spec is dedicated and excluded
from the general Playwright configuration so its authenticated page loads
cannot consume another suite's background-job fixtures.

## Pull requests

Protected `main` requires a pull request and both `verify` and
`postgres-integration`. Do not bypass failed checks. Production release,
migration, maintenance, and recovery-checkpoint evidence is recorded privately,
not in public workflow logs.
