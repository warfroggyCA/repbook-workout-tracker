# Architecture and data contracts

Repbook Workout Tracker is a Next.js App Router application. Server actions and route
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

## Program editing and activation review

The editor prepares an editable current-schema draft from the immutable active
Program. Automatic preparation of an older Program remains separate internally
from deliberate user changes; it is never counted as something the user chose
to edit. The normal review screen presents the safety result and any issues that
need attention instead of a field-by-field comparison. Activation still
requires an exact saved-revision review and creates a new immutable Program
version.

Cross-version drafts are schema-validated and fenced by their saved revision
and canonical content hash. Harmless legacy JSON fields do not block activation
or become part of the new immutable version.

An older exercise group with unequal member set counts stays explicitly marked
as legacy when another Program edit is activated. Repbook preserves its saved
sets, order, and rest instead of writing an invented round count back into the
Program; execution and simulation run through the largest saved set count and
skip each member after its own sets are complete. The editor offers an optional
conversion to matching rounds.

Warm-up instructions and optional structured check-off steps are both reviewed.
Older free-text instructions stay free text and remain complete; a historical
generated prefix item never overrides the full overview. Independently authored
structured steps remain independent. Workout creation and the saved Program
presentation use authored structured steps when they exist, so the reviewed
content is the content shown during the workout.

Every change to weekly work-set totals must be accounted for internally by an
add, removal, replacement, or target change. If the review cannot account for a
set total, activation fails closed.

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

## Active-workout orientation

Today keeps choosing a Program day separate from starting a workout. The
expected next day retains the direct **Train as planned** action. Choosing a
different current Program day opens a URL-backed preview of its planned
exercises; opening, reloading, leaving, returning, or following an invalid or
stale preview link creates no session. Only the preview's separate **Start
workout** action enters the authenticated, owner-scoped session lifecycle.
Neither path rewrites the Program, and the existing one-active-workout and
replay-safe start protections remain authoritative.

The active workout derives both **Now** and **Next** from the same ordered
occurrence ledger used to save results. A pending warm-up remains the current
action until its completion or skip is durably acknowledged; a saving or failed
request does not advance the display. After acknowledgement, the next grouped
exercise opens and receives focus. Restoring an earlier action makes that action
current again. Completed warm-up details collapse without discarding their
notes, outcomes, or restore controls.

Rest alerts remain device-local. The ready state is compact and visually
distinct, while sound and vibration reporting is limited to whether an alert
was requested, blocked, or unavailable; the application never claims that a
person heard or felt it.

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
Its pending notice refreshes in place whenever the current rule, explanation,
evidence, sessions, severity, or release time changes. Dismiss hides only that
displayed notice and records a separate audit event; it is not a rejection,
does not snooze a later notice, and changes no Program. If the raw evidence
still qualifies during a later evaluation, Review can show a fresh notice.

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
