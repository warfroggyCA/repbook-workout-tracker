# Repbook Workout Tracker

Repbook Workout Tracker is a single-user, tracker-first workout application with an
optional, approval-gated coaching layer. Logging a workout never requires an AI
provider, and no automatic recommendation changes the user’s Program.

This repository is a sanitized source snapshot. Private operational history,
production-maintenance automation, real workout observations, and owner data
remain in a separate private operations repository and are intentionally not
part of this public Git history.

Start with the [public documentation guide](docs/README.md). This repository
owns application behavior and durable public contracts; the private operations
repository owns volatile production status, release chronology, and product
priority.

## Technology

Next.js App Router, TypeScript, React, Drizzle ORM, Postgres, Auth.js, Vitest,
and Playwright.

## Local development

```bash
npm install
cp .env.example .env.local
npm run db:push
npm run db:seed
npm run dev
```

With no `DATABASE_URL`, local development uses an embedded PGlite database in
`.pglite/`. The sample allowlisted account is synthetic. AI keys are optional;
`AI_FAKE=1` enables canned local responses.

`db:push` is for disposable local data. Existing or production databases must
use the checked-in additive migration history through `npm run db:migrate`.

## Verification

```bash
npm run test
npm run test:integration:postgres
npm run typecheck
npm run lint
npm run build
npm run docs:check
```

The pull-request workflow also replays migrations, checks dependency policy,
and runs the signed-in browser matrix in Chromium and WebKit.

The [documentation guide](docs/README.md) routes each kind of change to its
authoritative contract.

## Contributions and security

Issues and pull requests must use synthetic data only. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the contribution boundary and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

No license is granted by publication of this source.
