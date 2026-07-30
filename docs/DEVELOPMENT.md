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
```

Run the smallest affected browser suite first, then the complete protected
workflow for a merge candidate. All browser fixtures must remain synthetic.

## Pull requests

Protected `main` requires a pull request and both `verify` and
`postgres-integration`. Do not bypass failed checks. Production release,
migration, maintenance, and recovery-checkpoint evidence is recorded privately,
not in public workflow logs.
