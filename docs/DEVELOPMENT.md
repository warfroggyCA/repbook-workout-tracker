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

The Repbook v2 semantic foundation and current T01 activation package have
focused gates:

```bash
npx vitest run tests/unit/v2-semantic-contract.test.ts
npx vitest run tests/unit/v2-t01-recording-truth-db.test.ts tests/unit/v2-t01-recording-truth-portability.test.ts tests/unit/v2-t01-recording-truth-restore.test.ts tests/unit/v2-t01-recording-truth-adversarial.test.ts
npx playwright test tests/e2e/v2-t01-recording-truth.spec.ts
```

The semantic test validates all synthetic F01-F17 scenarios and every required
verification-matrix cell; by itself it proves contract consistency only. The
T01 tests activate the mapped database, browser, portability, recovery, and
adversarial claims for truthful performed measurement. Every later package must
activate its own reserved evidence before its product behavior is considered
implemented.

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
