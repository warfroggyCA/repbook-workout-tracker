# Repbook Workout Tracker engineering instructions

## Product boundary

Repbook Workout Tracker is a single-user workout logger with optional AI assistance.
The tracker must remain fully usable without an AI call. Program changes,
recommendations, and review proposals are distinct concepts; only an explicit
user decision may change the Program.

## Required reading

Before application changes, read:

- `docs/ARCHITECTURE.md` for system ownership and persisted-data contracts.
- `docs/DEVELOPMENT.md` for repository commands and verification.
- `docs/SECURITY_AND_PRIVACY.md` for public-repository and data-handling rules.
- `docs/PROVENANCE.md` before comparing this sanitized history with the private
  operational archive.
- Relevant installed Next.js guidance under `node_modules/next/dist/docs/`.

## Non-negotiable data contracts

- Completed workouts and activities are historical evidence. Preserve stable
  identities, recorded units, local calendar dates, IANA timezones, timestamps,
  Program lineage, raw pain observations, provenance, and record versions.
- Program intent, performed workout evidence, Coach/Review proposals, and
  independent activities remain separate.
- Unknown, missing, contradictory, legacy, or cross-version meaning must stay
  explicit. Never replace unknown meaning with a convenient default.
- Corrections, archive/restore, snapshot restore, import/export, and
  record-version rollback must preserve facts and invalidate or recompute
  derived conclusions where required.
- Never add an automatic Program mutation. Recommendations remain
  approval-gated.
- External-analysis packages are owner-selected, purpose-bounded, versioned,
  previewable, and downloaded without automatic transmission. Package contents
  never become performed facts, recommendations, decisions, or Program changes.
- Schema work is additive. Never edit an applied migration or silently rewrite
  historical rows.

## Privacy and security

- Use synthetic identities and synthetic workout data in source, tests, issues,
  pull requests, screenshots, and logs.
- Never add real workout observations, owner identifiers, production response
  bodies, secrets, credentials, deployment IDs, database branch IDs, or private
  operational records to this repository.
- Production-maintenance scheduling and its logs are deliberately owned by the
  private operations repository. Do not recreate those workflows here.
- Validate authorization at server boundaries. Do not expose secrets to client
  bundles, logs, exports, or error responses.

## Architecture and implementation

- Inspect all producers, consumers, correction paths, exports, snapshots,
  restores, and version paths before changing consequential persisted meaning.
- Use the established services and schema modules; avoid duplicated
  interpretations of the same fact.
- Make the smallest complete change and add focused regression coverage.
- Keep public documentation accurate without copying private release history.

## Verification

Use the repository scripts. At minimum for application changes, run focused
tests, `npm run typecheck`, `npm run lint`, `npm run build`, and
`npm run docs:check`. Persisted-data or cross-cutting changes also require
migration replay, the PostgreSQL integration suite, affected export/recovery
tests, and relevant browser flows. The protected pull-request workflow is the
authoritative public merge gate.
