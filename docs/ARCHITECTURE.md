# Architecture and data contracts

Workout Tracker is a Next.js App Router application. Server actions and route
handlers own authenticated mutations; services own domain behavior; Drizzle
schema and additive SQL migrations own persistence; React components own
presentation; Vitest and Playwright cover pure, database, recovery, and browser
contracts.

## Primary product loop

The Program describes intent. A compiled session prepares one occurrence of
that intent. The active workout records what actually happened. Completion
creates historical evidence and queues deterministic progression evaluation.
Coach and Review may propose changes, but an explicit user decision is required
before a Program prescription changes.

These concepts must never be collapsed:

- Program intent
- performed workout evidence
- Coach or Review proposals and decisions
- independent activity context

## Persisted evidence

Completed workouts, session exercises, sets, pain observations, local dates,
IANA timezones, units, exercise and Program lineage, audit events, and record
versions are consequential facts. Their stable identities and performed-time
meaning survive export, snapshot capture, restore, archive, correction, and
version rollback.

Missing or unsupported evidence stays unknown. A current exercise definition
must not silently reinterpret an older record. Restores and corrections must
recompute or invalidate derived recommendations instead of reviving stale
conclusions.

## Pain safety hold

Progression uses one shared pain-hold classifier for an exact stable exercise.
Raw positive pain observations from completed, unarchived workouts contribute
to recurrence. An observation of 3/10 or higher holds a load increase until 14
days have passed without another 3/10-or-higher observation for that exercise.
An observation of 5/10 or higher, or positive observations across at least
three completed sessions inside the 14-day window, requests an alternative
instead. A recurrence-only alternative review clears when fewer than three
linked sessions with positive observations remain inside that window.

A missing pain entry and an explicit zero are preserved as different facts.
Neither is invented as a pain-free session and neither shortens the wait.
Contradictory or out-of-order evidence is classified deterministically from its
retained time, severity, stable identity, and provenance. Corrections, archive
restore, snapshot restore, and version restore use the same classifier. The
hold explains itself to the user but never changes the Program automatically.

## Ownership map

- `src/db/schema/` and `src/db/migrations/`: durable schema and additive history
- `src/services/`: authenticated domain operations and cross-record invariants
- `src/engine/`: pure deterministic calculation and progression rules
- `src/app/actions/` and `src/app/api/`: trust and authorization boundaries
- `src/components/`: user-visible state and interactions
- `tests/unit/`: pure, integration, recovery, export, and database contracts
- `tests/postgres-integration/`: true PostgreSQL concurrency behavior
- `tests/e2e/`: signed-in browser behavior with synthetic data

## Recovery and portability

JSON export and encrypted snapshots cover the complete owned-data manifest.
Restore validates schema and ownership, preserves immutable facts, and
reconciles derived state. Applied migrations are immutable; corrections use a
new additive migration and must prove repeatability, partial-failure safety,
and representative existing-data behavior.

## Public/private operations boundary

This public repository owns application source and pull-request verification.
The private operations repository owns real release chronology, production
maintenance scheduling, response metadata, retained recovery checkpoints, and
any evidence derived from real workouts. Public code must not depend on those
private records to build or test.
