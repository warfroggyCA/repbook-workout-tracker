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

The semantic test validates all synthetic F01-F17 scenarios and every required
verification-matrix cell; by itself it proves contract consistency only. The
T01 tests activate the mapped database, browser, portability, recovery, and
adversarial claims for truthful performed measurement. T02 activates the same
evidence classes for acknowledgement, retry, and reviewed correction, including
correction-lineage restore. T03 activates planned-order, extra-before/after-plan,
group ordering, History/Review/export, and recovery evidence. T04 activates
one-action-per-authored-warm-up truth, reversible acknowledgements, aggregate
exercise-decision safety, portability, recovery, and desktop/mobile browser
evidence. T05 activates acknowledgement-ordered current/next guidance,
source-bound durable rest, group/member/round mixed-resolution state,
ready-to-finish without implicit completion, portability, recovery, and
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
logging point now shows only exact, semantically compatible previous-set
evidence with a source link or an explicit unavailable state. The 390 by 844
surface keeps the current action primary and moves ordinary progress and
secondary exercise tools into keyboard-accessible native disclosures without
hiding pending writes, retry, skipped recovery, rest, finish, or saved-set
correction.

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
keeps cardio, recovery, and rest as non-resistance events. Parser internals and
canonical routine syntax are unchanged.

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
