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

The Repbook v2 semantic foundation and current T01/T02/T03/T04/T05/T06/U01/U02/U03/H01 activation
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
Recovery manifest 10 remains the
authoritative table inventory. Every later package must activate its own reserved
evidence before its product behavior is considered implemented.

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
npm run test:e2e:v2-u02
npm run test:e2e:v2-u03
npm run test:e2e:v2-gauntlet-a
npm run test:e2e:v2-h01
```

Run the smallest affected browser suite first, then the complete protected
workflow for a merge candidate. The Stage 5 timer suite requires an unused
`STAGE5_RUN_ID` matching its documented format. All browser fixtures must
remain synthetic.

## Pull requests

Protected `main` requires a pull request and both `verify` and
`postgres-integration`. Do not bypass failed checks. Production release,
migration, maintenance, and recovery-checkpoint evidence is recorded privately,
not in public workflow logs.
