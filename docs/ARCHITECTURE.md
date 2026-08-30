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

## Program editing and future publication

The editor prepares an editable current-schema draft from the immutable active
Program. Automatic preparation of an older Program remains separate internally
from deliberate user changes; it is never counted as something the user chose
to edit. The normal review screen presents the safety result and any issues that
need attention alongside an expandable exact before-and-after change list.
Publication still requires an exact saved-revision review and creates a new
immutable Program version used only by workouts started afterward. An active
session keeps its start-time snapshot; completed and imported History and every
earlier Program version remain unchanged.

Cross-version drafts are schema-validated and fenced by their saved revision
and canonical content hash. Harmless legacy JSON fields do not block publication
or become part of the new immutable version.

An older exercise group with unequal member set counts stays explicitly marked
as legacy when another Program edit is published. Repbook preserves its saved
sets, order, and rest instead of writing an invented round count back into the
Program; execution and simulation run through the largest saved set count and
skip each member after its own sets are complete. The editor offers an optional
conversion to matching rounds.

Warm-up instructions and optional structured check-off steps are both reviewed.
Older free-text instructions stay free text and remain complete; historical
generated overview projections never become check-off actions or override the
full overview. Independently authored structured steps remain independent.
Workout creation and the saved Program presentation use only authored
structured steps as actions, so one retained action produces one occurrence.

Every change to weekly work-set totals must be accounted for internally by an
add, removal, replacement, or target change. If the review cannot account for a
set total, publication fails closed.

## Program paste intake contract

Program paste intake is an untrusted, owner-scoped staging workflow. Provider
output is accepted only through the strict draft schema; it cannot supply
durable identities. The server normalizes the result to `program-input/1` and
derives stable day, slot, and warm-up UUIDs from a private in-memory digest of
canonical source text plus entity ordinals. The raw paste is bounded to 20,000
characters, retained only under the existing short privacy window, and removed
on discard, parse failure, or successful publication. The normalized package,
mapping decisions, parser version, AI-event references, and active Program
version are bound by a canonical stage digest.

Confirmation sends `program-input-review/1`. It must identify the exact staged
digest and the active Program version seen when parsing began. The server
revalidates owner scope, catalog identity, current equipment availability,
prescription bounds, warm-up anchors, load units, note duplication, and every
day and slot intent before one atomic schema-3 publication. Fresh paired groups
must retain at least two exercises with the same planned set count so complete
round reductions match the reviewed minimums. Authored group order also owns
rest meaning: every non-final member's rest is the shared pause before the next
member, while the final member's rest is the pause after the complete round.
Those exact values publish to the Program group and are copied into normal or
compiled session snapshots; unrepresentable mixed between-member rests fail
review. The parser preserves authored per-set rep sequences, but the current
Program prescription stores one exact target or range per exercise. A sequence
with different per-set targets therefore fails closed and is discarded with a
rewrite instruction; it is never widened silently into a range. A matching retry
returns the first publication; changed reuse conflicts. A stale Program,
malformed review, unavailable exercise, or failed publication leaves the stage
reviewable and creates no Program version. Exact equipment-fit review is a
server-required durable attestation, not a browser-only gate. Discard is
owner-scoped, replay-safe, and clears raw and normalized paste content plus
linked unconfirmed provider parse records.

The review displays and edits every retained warm-up and the compiler-relevant
minimum, priority, and protection choices in ordinary workout language.
The offline canonical grammar also retains an adjacent `Exercise notes:` line
on the exact exercise; a detached or duplicate notes line fails closed instead
of being guessed onto another movement.
Generated starting values are based only on pasted row structure and are not
presented as owner-goal or History evidence. The current compiler preserves
exercises, order, and pairings; it reduces only complete sets or complete group
rounds from eligible work, never below the reviewed minimum, and does not
invent substitutions or omissions. Other versioned intent remains context for
a separately reviewed future compiler.

`program-input/1` is also the contract foundation for a later validated
external-assistant package. Routine parsing remains separate from Program
library and scheduling behavior.

Current equipment availability proves only catalog requirements against broad
inventory and movement constraints. Import therefore requires the owner to
confirm that every retained exercise fits the exact physical setup and offers
only catalog choices that pass current availability checks. A reusable
owner-specific exercise/equipment incompatibility—such as a cable movement
that cannot use the owner's pulley geometry—needs a new additive relation plus
snapshot, restore, export, Coach, alternatives, and audit participation. That
schema/recovery tranche is deliberately separate; this contract never infers
physical compatibility from display names or from “cable station” alone.

## Program phases and scheduling

Routine templates remain the simple, stable source of exercises, order, sets,
repetitions, loads, rest, groups, warm-ups, and notes. The separate
`program-schedule/1` document references routine lineage only. It adds finite,
contiguous phases and either fixed seven-day or rolling rotations without
copying routines or changing the routine parser.

A schedule publication is an immutable version pinned to the active
Program version. Its durable occurrences represent future intent and distinguish
resistance, cardio, recovery, and rest. Rolling rotations continue across
calendar-week boundaries. A missed event changes only through an explicit skip,
manual reschedule, or rolling-tail shift; same-day resistance compression is
rejected.

A schedule version can be replaced only before any occurrence has been started,
completed, skipped, abandoned, manually rescheduled, or shifted. Publication
then fails atomically and leaves the existing schedule graph untouched. This
deliberately small Phase 1 rule prevents schedule edits from recreating
attendance or silently discarding an overdue event; a later cutover design must
preserve those same facts before post-use replacement can be enabled.
Publication locks the schedule root and every current occurrence before this
check. Event adjustment, non-resistance completion, and scheduled workout Start
use the same schedule-root-first order. Workout Start first claims the shared
owner-profile compare-and-swap revision used by Program switching, then takes
the schedule locks, so a contender with a stale revision cannot let switching,
calendar intent, and workout execution win conflicting races.

Workout Start locks the exact scheduled resistance occurrence, resolves its
routine lineage against the then-current Program version, and creates the
session in the same database statement. The session stores a self-contained
schedule snapshot alongside the existing frozen exercise prescription. A later
routine, Program, phase, schedule, or calendar change cannot reinterpret that
workout. Completion and abandonment update the plan occurrence when it still
matches, but the workout remains the authoritative performed record.

Migration 0081 adds the schedule root, immutable schedule versions, operational
events, and the nullable workout snapshot without backfilling existing Programs
or sessions. Snapshot schema 33 and recovery manifest 15 add all three schedule
tables to full backup and restore. History-only restore preserves the destination
calendar and restores the self-contained session snapshot with workout history.
Full restore recomputes every immutable schedule version's canonical occurrence
window and rejects missing, extra, or falsified dates, phase/event identities,
routine lineage, week, cycle, or timezone evidence before replacement.

The document layer adds no program-plan parser, RIR overrides, progression
engine, monitoring inputs, or automatic Coach adaptation. Those later
capabilities must compose with this boundary and remain explicitly reviewed;
they must not expand the routine parser or mutate history.

Migration 0082 adds a non-archived `inactive` Program state. An owner may keep
multiple named Programs, but exactly one remains active and therefore supplies
Today, Program editing, and current recommendations. Switching changes only the
two Program status rows in one owner-scoped statement, is blocked during an
active workout, expires suggestions tied to the prior current plan, and never
edits immutable Program versions or completed sessions. Switching and workout
Start contend on one owner-profile compare-and-swap revision, so the second
operation cannot commit from a statement snapshot taken before the first one.
Routine import makes the destination explicit: publish a new version of the
active Program, or keep that Program saved and activate a new named Program.

The owner-facing schedule editor is deliberately narrower than the document
contract: it authors one fixed seven-day or rolling phase with resistance,
cardio, recovery, and rest events. Multi-phase or otherwise advanced documents
remain executable and are shown without being flattened. Once any event is
used or adjusted, the editor becomes read-only and Today owns the explicit
complete, skip, reschedule, and rolling-shift actions. Today passes the exact
scheduled occurrence identity into Start, so routine-only Start remains the
legacy fallback only when no schedule exists; alternate routines stay
preview-only until the scheduled event is explicitly changed. Snapshot schema
34 preserves saved inactive Programs and restore requires exactly one active
Program whenever usable Programs exist; recovery manifest 15 retains the same
table inventory.

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
occurrence ledger used to save results. Warm-up acknowledgement remains
server-authoritative. A working set first receives a stable client command and
an exact durable device copy; the client may then present the next occurrence
immediately while the server acknowledgement is pending. The server ledger
remains canonical, retries reuse the same command identity, and failed writes
stay visible and recoverable without rolling the owner back. Restoring an
earlier action makes that action current again. Completed warm-up details
collapse without discarding their notes, outcomes, or restore controls.
When warm-ups were included at Start, every pending preparation remains visible
in one opening warm-up sequence. All selected preparation must be resolved
before any working set becomes available, so a later working card cannot appear
inexplicably unavailable during the workout. A blocked working set names the
opening preparation and can reveal and focus it. These views are derived from
the immutable occurrence ledger; they never create a late warm-up or bypass the
authored order.

Rest alerts remain device-local. The ready state is compact and visually
distinct, while sound and vibration reporting is limited to whether an alert
was requested, blocked, or unavailable; the application never claims that a
person heard or felt it.

## Product-polish hierarchy contract

Today presents the current training decision as its one dominant action. The
secondary record paths—standalone activity, retrospective workout, contextual
note, and Quick Log—share one **Add training** sheet instead of permanent
dashboard cards. A safe equipment preflight and an empty Program-decision state
render nothing. Programmed warm-ups remain off by default and are available
under the Start form's explicit **Workout options** disclosure. The Today page
does not load dashboard statistics or recent-workout rows; its owner-scoped
query budget is seven.

Completed-workout History derives one four-question summary from retained facts:
what happened, what changed against compatible frozen targets, what was notable,
and whether anything needs the owner's decision next time. The derivation is
pure and deterministic. Unsupported targets, missing duration, missing pain
evidence, legacy outcomes, and mixed units remain explicit limitations; no AI
inference fills them. Performed evidence and plan comparison follow the summary.
Corrections, archive, the full occurrence ledger, retained source rows, source
lineage, and non-positive pain evidence live in the final closed **Technical
record** disclosure. Positive pain evidence remains prominent before performed
work, and recommendations remain separate from recorded facts.

Athlete-facing ambient intelligence is a read-time projection, not a new
coaching or persistence layer. `src/lib/athlete-insights.ts` owns one pure
`AthleteInsightCandidate` contract, deterministic fingerprints and ranking,
and conservative generators. Today may show one versioned, supported pending
decision that has already passed the live recommendation-evidence gate. The
active workout may show one exact recent-best or usual-rest signal per exercise;
the former requires a saved current set plus the exact comparable exercise,
load meaning, load value, and unit, while the latter requires at least four
safe recorded rest samples across two workouts. Completed History may replace
the target-only change answer with one session result only when exact exercise
identity, complete v1 performed semantics, longitudinal eligibility, and a
single recorded load unit all hold. Positive pain or limitation context on the
exact set or exercise (or unscoped session pain), legacy semantics, current
imported sessions, mixed units, sparse history, and
unknown completion evidence suppress the affected conclusion. Candidates are
never stored, never create or apply a recommendation, and never change the
Program. **Explain** only prefills the existing Live Coach editor after an
explicit athlete action; sending the question remains a second explicit action.

The contextual-note provider owns composition and durable device-queue recovery
without rendering an always-present global toolbar. Routes provide contextual
entry points instead: Today's Add sheet, the active-workout status bar, Program,
and History's More menus. A real pending or failed device copy still surfaces on
every route, including an active workout, until it is acknowledged or explicitly
resolved.

## Pain safety hold

`src/lib/pain-evidence.ts` owns `pain-evidence-v1`: missing evidence is
`unknown`, a supported general 0/10 report is `explicit_no_issue`, supported
1–10 evidence is `pain`, and malformed or unsupported retained evidence is
`unsupported`. Progression uses that meaning plus one shared pain-hold
classifier for an exact stable exercise.
Raw positive pain observations from completed, unarchived workouts contribute
to recurrence. An observation of 3/10 or higher holds a load increase until 14
days have passed without another 3/10-or-higher observation for that exercise.
An observation of 5/10 or higher, or positive observations across at least
three completed sessions inside the 14-day window, requests an alternative
instead. A recurrence-only alternative review clears when fewer than three
linked sessions with positive observations remain inside that window.

A missing pain entry and an explicit zero are preserved as different facts.
Neither is invented as a pain-free session and neither shortens the wait.
Supported positive `set_exception` evidence participates in the same
proposal-only hold; its exact completed set, performed exercise, planned
exercise, and substitution context remain separate. Program preflight,
simulation, and Session Compiler do not consume that bridge directly.
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

## Repbook v2 verification foundation

The ratified v2 semantic contract is represented here by synthetic fixtures at
`tests/fixtures/v2/semantic-scenarios.json`, a pure test-only oracle, and the
machine-readable matrix at `docs/repbook-v2-verification-matrix.json`. These
artifacts define expected meaning and exact activation-test ownership. P02
remains contract-only. T01 activates its database, browser, portability,
recovery, and adversarial proofs for truthful performed measurement. T02
activates those proof classes for acknowledgement, retry, and reviewed
correction. T03 activates database, browser, portability, and recovery proofs
for planned order and extra-set truth. T04 activates the same required proof
classes for warm-up occurrence truth. T05 activates them for current, next,
group, and rest truth. T06 activates preview and Start truth, including
prescribed exercise meaning. U01 activates the presentation-only active-workout
hierarchy and ergonomics gate. U02 activates optional set-level effort, issue,
note, and linked pain evidence from capture through Review, export, and recovery.
U03 activates exact future-only Program review and publication clarity together
with active-session, History, earlier-version, failure, conflict, and restore
isolation evidence. Gauntlet A passed on its exact unmerged candidate. H01
activates performed-first completed and imported workout presentation without a
new writer or persisted meaning; later History and Coaching packages remain
future work.

## T01 performed-measurement contract

An acknowledged set retains a performed-time semantic snapshot rather than
depending on a mutable current exercise definition. The supported shapes are
loaded repetitions, unloaded repetitions, assisted repetitions, duration, and
distance with optional duration. Each shape accepts only its applicable fields:
inapplicable measurement fields remain null, recorded load retains its exact
unit, and assistance keeps its explicit assistance direction. Activity-only
observations and combined loaded timed or distance work fail closed until a
later contract supports their complete meaning.

The write also retains the performed occurrence and canonical exercise
identities, including a workout-only substitution, observed-time provenance,
and the independent prescribed fields already attached to the set. An exact
retry may acknowledge the original saved result even after catalogue metadata
changes; reuse of the retry identity with different evidence is rejected.
Older queued command envelopes are quarantined because they do not carry the
full T01 evidence contract.

T01 does not reinterpret completed legacy rows whose performed-time semantics
are absent. Exports and encrypted restore preserve that uncertainty, and
restore recomputes or invalidates projections from retained facts. Historical
batch repair remains blocked.

## T02 acknowledgement and correction contract

A set is still unacknowledged while its write is saving, retrying, or failed,
but its exact durable device copy may optimistically advance the active-workout
display. Only server acknowledgement creates canonical performed history or
exposes correction. The client keeps a stable command and occurrence identity
across retry, the service accepts an identical replay without duplicating
evidence, and reuse of that identity with different evidence fails closed. A
failed copy remains visible with retry and deliberate discard; it never silently
disappears or rolls the display back. Older outbox formats are quarantined for
explicit recovery instead of being guessed into the current contract.

Correction is a reviewed superseding assertion, never an edit in place. The
owner reviews the exact original and replacement values, selects a reason, and
confirms the decision. The service fences the write by owner, workout state,
occurrence identity, complete expected assertion, and workout history revision.
It retains before/after data, decision provenance, a monotonic correction-ledger
revision, and the effective history revision. Active corrections do not trigger
progression; completed corrections expire stale proposals and queue evaluation
against the new revision; abandoned evidence remains excluded.

Record-version restore is itself a new correction transition. Recovery manifest
10 merges immutable source correction versions with destination-only history,
rejects reused version identities with conflicting content, and appends a
snapshot-restore transition whenever an existing performed set changes. It does
not erase intervening evidence or imply a historical batch repair. CSV presents
the current effective assertion; canonical JSON and encrypted snapshots retain
the original, superseding assertions, and their evidence chain.

## T03 planned-order and extra-set contract

Planned working occurrences keep their immutable sequence and ordinal. A later
planned set for the same exercise, group member, or group round cannot be
completed or skipped while its earlier planned predecessor is pending.
Unrelated ungrouped exercise work remains independently actionable.
An explicit whole-exercise skip may resolve that exercise's remaining
occurrences atomically, but it fails closed when doing so would cross a pending
group predecessor belonging to another exercise.

An owner may add and perform an extra before or after planned work. The extra is
appended as a distinct ad-hoc occurrence, labelled only among extra siblings,
and never renumbers or displaces the planned current action. Workout-only
exercise sets remain a separate ad-hoc role rather than being relabelled as
extras.

Extra work remains valid performed evidence for volume and progression where
its measurement semantics permit, but it is excluded from planned-target and
adherence claims. New writes, corrections, Review, History, exports, and
snapshot restore all enforce that boundary. Existing history is interpreted
through retained occurrence origin; T03 performs no batch rewrite.

## T04 warm-up occurrence contract

Free-text day and exercise warm-up overviews are reference guidance. A Today
Start defaults to working sets only. The owner must explicitly select
**Include programmed warm-ups** before Start for authored structured warm-up
items to become checkable occurrences in that workout. The choice is bound to
the idempotent Start request; declining it leaves the exact Program and session
warm-up snapshots intact without creating performed, skipped, or pending
warm-up facts. Internal compiler and retrospective producers keep their
explicit source contract. When warm-ups are included, the active workout and
History show each structured action once; they do not repeat the same item
inside exercise guidance. Existing overview projections remain readable but
are not silently converted into performed or skipped evidence.
Known pending projections retained by the conservative legacy backfill are
excluded from active controls and rejected at the mutation boundary without
rewriting the stored row; independently authored structured actions remain
actionable.

For schema-3 Program days, `beforeSlotLineageId` identifies the lift that a
structured preparation item supports. Null or absent means general day
preparation; a same-day slot lineage means lift-specific preparation. Unknown
and cross-day anchors are invalid. Normal Start and Session Compiler materialize
general items first, then all linked `exercise_warmup` occurrences in Program
slot order, then every working occurrence. Older slot-level warm-up sets remain
linked legacy actions after newly anchored items for that same exercise. The
Program editor may retarget the item only to another slot in that day and does
not copy an anchored item across days. Existing active and completed sessions
keep their frozen occurrence order; the opening-only rule applies when a new
workout is started.

Program paste publication has a server-side emergency stop independent of the
anchor-aware readers. `PROGRAM_TEXT_IMPORT_ENABLED=false` blocks new parse and
confirm operations before durable mutation while existing Programs remain
readable and staged reviews remain preserved. Rollback deployments must retain
the anchor-aware schema, normal and compiled occurrence ordering,
editor/recommendation publication, export, and recovery paths. A build that predates
the PII-01A staged-review contract is compatible only before any new-format
review may have been staged. It is not a truthful general rollback afterward:
the old review reader can strip warm-up timing before publication, and the old
Program reader can strip or misplace it after publication.

Each warm-up occurrence keeps its immutable session, planned-exercise,
prescription, order, and equipment identity. Note, complete, skip, and restore
are revision-fenced, replay-safe mutations with immutable receipts. A user may
undo a completed or skipped warm-up while retaining its independent note. The
additive `0071_warmup_occurrence_reversal` migration permits that narrow
completed-to-pending correction for warm-ups only; completed working-set
evidence remains immutable.

Whole-exercise skip and substitution remain aggregate decisions. They resolve
only applicable pending warm-ups with an explicit aggregate reason, ordinary
un-skip cannot revive substitution-specific actions, and only undoing the
exact substitution may restore those actions. An action cannot become pending
under a skipped or different performed exercise. Abandonment retains completed
or skipped acknowledgements and resolves only pending actions. CSV, Review,
encrypted snapshot restore, and device-outbox discard preserve the same stable
identity and do not synthesize warm-up facts. T04 performs no historical batch
repair.

## T05 current, next, group, and rest contract

The immutable occurrence ledger is the only source for canonical current and
next work. Newly started workouts place every selected warm-up before working
sets; pending occurrences retain their frozen sequence across warm-ups,
working sets, extras, skips, retries, and corrections; expanding or collapsing
an exercise card cannot reorder them. For responsive working-set entry, an
exact locally durable command temporarily resolves only that same occurrence in
the client projection. It does not change server truth or the performed count,
and the retained row remains recoverable until acknowledgement. Once no pending
occurrence remains, the session is ready to finish but is not completed until
the owner explicitly chooses Finish workout.

Rest is a first-class, device-durable focused action created from the same
owner gesture that durably queues a working set. It stores a stable timer ID,
the workout/exercise/occurrence/client command identity, observed start,
absolute end deadline, original duration, phase, and idempotent cue state. The
display always derives remaining time from `endsAt - Date.now()`; intervals only
refresh presentation. The status bar describes that source-bound timer in terms
of the next actionable destination so an exercise boundary is explicit. When
the queued set exhausts the actionable ledger, no timer is created and the
status bar moves directly to ready-to-finish. Server acknowledgement enriches
an existing timer with the completed-set ID without resetting its deadline. A
delayed acknowledgement may clear only the timer associated with its own client
command, never a newer timer. Saved occurrence evidence still classifies
positive rest as straight-set, between-member, or between-round rest; zero
means explicitly no rest and null means unknown rest.

Finish is also the deliberate bulk exit from an active workout. When planned
occurrences remain, the owner chooses one session-level reason and the existing
completion transaction resolves every still-pending occurrence together; the
owner never has to manufacture individual set or exercise skips first. A
confirmed whole-exercise skip may still offer replacement, but that optional
choice does not block Finish. An unconfirmed skip or retained recorded-work
command continues to block completion until its outcome is known.

Group, member, and round progress is derived from the same occurrence outcomes,
not from a second execution state. Fully performed work is resolved; a fully
settled mix containing skips, abandonment, or limited evidence is
resolved-with-changes. T05 adds no historical rewrite or migration and does not
reinterpret unsupported legacy evidence.

## Deployment continuity contract

Each hosted build uses Vercel's deployment identity for Next.js version-skew
protection. If an installed app still holds Server Action references from an
older build, the durable workout-set, equipment-selection, occurrence, and
contextual-note queues retain their exact device copies, stop futile automatic
retries in that document, and show one in-flow reload action. Reloading clears
only the obsolete application document; local-storage identities and payloads
remain intact and retry against the current build. An action mismatch is not
reported as ordinary offline connectivity, and recovery UI must not cover the
active workout controls.

## T06 preview, Start, and prescribed-meaning contract

Preview is a URL-backed read-only projection. Rendering, reloading, leaving,
returning, or opening an invalid preview creates no workout. Each rendered
Start form owns one random UUID that remains stable across action failure and
retry. The server hashes the canonical template, timezone, and time-budget
payload and persists the key and hash together on the created workout. Exact
owner-scoped replay wins before Program freshness, including after the workout
becomes terminal. Reusing a key for different evidence is a conflict; a
different active workout is a separate truthful outcome and is never presented
as if the requested day started.

The same atomic Start statement captures version 1 of the prescribed exercise
name, metric type, load type, and load semantics. Session Compiler acceptance
does the same. Active display, Live Coach evidence, History, Review, and
exports use this snapshot for unchanged prescribed work, while explicit
substitutions and workout-only additions use their performed exercise meaning.
Legacy, imported, and completed-only rows keep the complete nullable tuple
null; no catalog metadata is inferred backward.

Additive migration `0072_preview_start_semantics` owns these identities and
immutability constraints. Canonical and encrypted snapshots use schema 28;
schema 27 upgrades add explicit null unknowns. The then-current recovery
manifest remained version 10 because no table was added, but its workout and session-exercise
contracts include the new evidence. Restore validates all-or-none tuples,
owner-scoped request uniqueness, UUID/SHA shape, and exact round trip.

## U01 active-workout hierarchy and ergonomics contract

The expanded card for the exact current working-set action leads with current
identity and the applicable performed measure. Ordinary logging exposes one
visible commit action. Exact save state follows that commit, the ledger-derived
next action follows the save state, and optional effort, set notes, and skip
controls use native progressive disclosure after the ordinary path. Prior-set,
warm-up-reference, coaching, and workout-only context remain available below
the active flow instead of preceding it.

The compact sticky summary keeps current identity and progress, but defers its
duplicate next line while the expanded current card owns that guidance. If the
card is collapsed or the focused action is warm-up or rest, the sticky summary
continues to show next work. U01 changes no occurrence ordering, writer,
acknowledgement, correction, rest, group, persistence, export, recovery, or
historical semantics and adds no schema migration.

## U02 exception-context contract

Ordinary set completion requires no exception fields. Optional details disclose
RIR or RPE (never both), one controlled technique issue, one controlled
limitation cause, a set note, and an optional pain observation. Missing values
remain explicit unknowns. Before the set is saved, every optional choice can be
cleared without affecting the ordinary performed measure.

One canonical set command carries the selected context through offline retry.
The completed set and any pain observation are written atomically, and pain is
bound to the exact owner, workout, exercise, and completed set. Exact retry
replays the acknowledgement; reusing the command identity with changed context
fails closed. Capture writes no recommendation, decision, or accepted adaptation.

History and Review present the recorded evidence as observations. The durable
`set_exception` pain source distinguishes set-linked evidence from the
general `set_flag` workflow. U02 observations do not
reinterpret the performed set, alter Program intent, approve a proposal, or
adapt future work. H04's `pain-evidence-v1` bridge now lets supported positive
set-linked evidence participate in Review and proposal-only pain holds and
progression recommendations. Explicit severity-zero general reports remain
no-issue evidence, and a missing record remains unknown. Program preflight,
simulation, and Session Compiler still do not consume this evidence directly,
and no pain evidence changes Program intent without an explicit owner decision.
Set and pain CSVs,
canonical snapshots, and restore retain the
exact nullable fields and completed-set link. Additive migration
`0073_exception_context` owns the new columns and linkage constraints. Snapshot
schema 29 owns this evidence; schema 28 upgrades add null unknowns without
backfilling from current catalogue, Program, or equipment metadata. Recovery
recovery manifest keeps the same table inventory while strengthening completed-set and
pain integrity checks.

## U03 future-write Program contract

The Program editor owns a durable future draft. Drafting and review do not
change the current Program. The review is tied to one exact saved revision and
shows the deliberate change labels plus expandable current and future values;
automatic preparation of older stored details remains separate from owner edits.

Publishing is one explicit action. It creates a new immutable Program version
for workouts started from that point forward. A workout already in progress
keeps its original Program, day, exercise, target, warm-up, and group snapshots.
Completed and imported History, earlier Program versions, recommendations,
decisions, and accepted adaptations are not rewritten or inferred by the edit.

Removing an exercise from an active workout and removing its Program slot are
separate owner actions. **Remove from today** affects only remaining work in the
active session. When the session retains exact source Program, day, and slot
lineage, the workout may instead open the Program editor at that exact slot and
ask the owner to stage its removal from future workouts. The editor fails closed
for missing, stale, mismatched, or conflicting lineage, and the staged removal
does not affect the active workout, current published Program, or completed
History. It takes effect only after the ordinary Review and Publish flow.

Discard removes only the open draft. A stale base, conflicting tab, obsolete
review, malformed document, or publication failure preserves recoverable owner
work or fails closed without advancing the Program. Restoring an earlier version
creates another draft and requires a fresh exact review before it can be
published as a new future version. U03 adds no schema, migration, historical
repair, production mutation, recommendation approval, or automatic adaptation.

## Gauntlet A milestone contract

Gauntlet A does not add a new workout meaning. It verifies the complete T01–U03
experience against one desktop reference and the 440×956 and 320×700 mobile
references at enlarged text. Ordinary work, supported bodyweight substitution,
group/rest order, structured warm-ups, planned skips plus extra work,
exception-only context, offline resume, timeout-after-commit retry, finish early,
and abandonment must retain one exact acknowledgement and remain usable without
horizontal overflow or unexplained browser errors.

Optional effort and overall fatigue use keyboard-operable native buttons whose
selected state is programmatically exposed. An abandoned session remains
distinct from a completed session: History and CSV export retain its acknowledged
sets and explicit occurrence outcomes, while progression, Review calculations,
and completed-workout metrics continue to exclude it. CSV carries the explicit
session status so retained evidence cannot be mistaken for completed training.

## H01 performed-first workout History contract

Completed and imported workout detail leads with acknowledged performed facts.
Only an active completed working-set occurrence linked to its retained set row
enters the performed working-set count. Completed structured warm-up occurrences
are shown as performed actions but remain separate from working sets. Skipped,
legacy-unknown, and unlinked source rows stay in the original plan or a distinct
retained-source disclosure and never inflate the performed count.

The terminal facet distinguishes completed, finished early, abandoned, and
in-progress workouts. In-progress History URLs redirect to the active session.
Finished-early meaning requires an abandoned occurrence with the exact
`finished_early` reason; a skip alone cannot imply it. Abandoned workouts retain
acknowledged facts for inspection and correction while excluding them from
completed metrics, progression, and Review.

Provenance, correction state, performed semantic support, and calculation
eligibility are orthogonal facets. Correction and restore history uses the
reviewed correction envelope and an allowlist of safe human-readable deltas;
raw envelopes and unknown fields are not rendered. Supported repetitions-only
evidence may remain eligible for exact named calculations even when loaded
workload and strength estimates do not apply. Missing performed semantics remain
legacy partial, malformed partial tuples remain unsupported, and neither is
inferred from current Program or catalogue metadata.

The performed set identity and measurement remain primary on each History
card, with correction directly reachable. Provenance, semantic support,
calculation eligibility, load meaning, setup meaning, and revision evidence
remain explicit inside one closed set-details disclosure so repeated evidence
copy does not obscure the recorded result.

Tracker-started and Session Compiler workouts are native Repbook provenance;
retrospective owner entry, import, and unclassified legacy sources remain
distinct. The correction headline follows the newest applicable set or workout
timing action, so a later correction after a restore does not keep an obsolete
restore label. Detailed earlier transitions remain inspectable underneath it.

H01 is a read-only presentation package. It adds no schema, migration, writer,
historical rewrite, calculation formula, recommendation, decision, adaptation,
or production action. The dedicated browser fixture is disposable and proves
the screen makes no post-login mutation.

## H02 cadence and planned-set outcome contract

H02 keeps training cadence and planned-set outcomes as separate calculated
views over retained evidence. Calendar cadence counts owner-scoped, unarchived,
completed workouts by their retained workout-local calendar date. Its weekly
average includes only complete Monday-to-Sunday weeks inside the selected
range; partial boundary weeks do not silently lower the result. Median and
current gaps are differences between those local dates, so a date-only import
can support a calendar gap without fabricating an observed clock time or
duration.

Program-day exposure groups historical workouts by stable source-day lineage
and retains every observed historical label. Unlinked workouts stay explicit.
The current profile frequency is a labelled comparison only: it is not the
historical prescription and does not produce an adherence percentage.

Planned-set outcomes use `prescription-outcome-v1`. A performed working set is
below, at, or above only when one exact planned occurrence supplies supported
repetition and load targets in compatible units. Missing, ambiguous,
percentage, text, or otherwise unsupported targets produce `unknown`. The
legacy stored `target_met` value remains a portability projection and is never
read as current calculated truth. History, Coach, Review, corrections, exports,
and record-version restores share this interpretation. Corrections and restores
recompute the outcome from the retained performed tuple and frozen occurrence
target without changing Program intent.

H02 adds no schema, migration, Program writer, historical repair,
recommendation, decision, adaptation, or production action. Its browser fixture
is disposable and verifies separate cadence and outcome presentation, truthful
unknown states, desktop and narrow enlarged-text mobile layout, and no
post-login mutation.

## H03 exact exercise evidence contract

H03 groups exercise history only by the stable performed `exercise_id` retained
on each session exercise. Shared catalogue, owner-created, and import-created
identities remain explicit scopes. Mutable names and families provide labelled
context only; they do not merge variants or reinterpret historical facts. The
frozen source occurrence key is not a reviewed mapping. Imported Hevy evidence
enters exercise calculations only when the current owner's source-scoped mapping
matches the exact performed exercise; a missing mapping is legacy evidence and a
mismatched mapping is unsupported. A substitution retains both the prescribed
exercise ID and the performed exercise ID.

Every retained completed set remains inspectable. Only a set with exactly one
completed working-set occurrence linked to the same session exercise may enter
exercise progression, selected-period best observations, workload, or records.
Missing and ambiguous links remain legacy evidence; unsupported performed
measurements remain unsupported. Supported facts are labelled as native, manual,
imported, or corrected according to their retained source and version evidence.
Derived results use the named `exercise-history-v1` algorithm and are never
presented as stored workout facts.

The Exercises workspace keeps exact exercise and evidence-tier filters in the
URL and carries them through supporting workout links and back navigation. CSV
exports preserve the same identity, scope, tier, frozen source occurrence,
reviewed mapping identity and confirmation time, link status, and algorithm
provenance. Owner-scoped reads and exports fail closed on a cross-owner exercise
or mapping identity.

H03 adds no schema, migration, writer, historical repair, recommendation,
decision, adaptation, or production action. Snapshot schema 29 and the recovery
manifest already cover the durable source facts; restore recomputes the derived
view.

## Gauntlet B milestone-coherence contract

During an active workout, the current action and its logging controls own the
usable surface. The compact progress summary is the only workout-level sticky
region. Structured warm-up actions remain in normal document flow and collapse
after resolution; long reference guidance is disclosed only on request. At
145% text, desktop, tall-phone, and 320 by 700 phone layouts retain at least 280
CSS pixels between persistent top and bottom regions and do not overflow
horizontally.

An exercise-level skip remains recorded as a performed-workout fact. The same
expanded card offers two explicit recovery branches after the server-confirmed
history revision arrives: replace the exercise for this workout or continue
without replacement. During that revision handoff it shows a concise checking
state instead of actions whose state could be discarded by the remount.
Replacement restores
only still-unperformed working-set occurrences that the exercise skip resolved;
an already acknowledged warm-up skip stays intact. The replacement, continuation,
and un-skip paths leave the saved Program and completed sets unchanged and retain
44-pixel touch targets.
Alternative and replacement catalog reads use a private, no-store Route Handler
so the device can abort them independently of the App Router mutation queue. A
failed or slow request leaves its workout-only drawer open with explicit retry
and return actions; retries use a new request generation so late responses
cannot replace the current result or strand the owner on a loading state.
If a replacement write proves the open catalog is stale, that drawer remains an
explicit blocking reconciliation surface until the current exercise is loaded;
the owner can retry there or leave safely to Today, but cannot resume logging
against the superseded exercise projection.

History-only snapshot restore treats owner decisions and accepted adaptations as
monotonic evidence. Recovery manifest 11 merges those rows, rejects contradictory
identity reuse, preserves a later terminal recommendation over an older pending
copy, and never resurrects a source-only pending proposal. The current Program
remains authoritative while workout history is restored. Preview fingerprints,
transaction rollback, and retry remain fail-closed. Full restore semantics are
unchanged. Gauntlet B adds no schema migration, snapshot-shape change, historical
repair, production action, or automatic Program decision.

## A01 versioned analysis-package contract

A01 adds an owner-controlled export at `/export/analysis` for one closed
analysis question and a selected 28-, 84-, or 182-day evidence window. One
repeatable-read snapshot supplies the complete package. The server allowlists
Program intent, exercise identity, completed or imported evidence, independent
activity context, calculated metrics, recommendation proposals, owner
decisions, and accepted future adaptations as separate domains. Stable source
IDs, revisions, local dates, IANA timezone, units, load meaning, provenance,
evidence quality, unknown states, inventory counts, and omission reasons travel
with those values. Current catalogue or Program metadata never repairs missing
historical meaning.

The question policy is an allowlist, not only a label. Program progress omits
independent activities; recovery and constraints omits general equipment
configuration; training consistency keeps workout timing, Program cadence, and
independent activity context while omitting detailed sets, recovery notes,
equipment, and recommendation state. Every such omission is counted and
explained. Legacy `target_met` projections live only in the calculated-metrics
domain and are explicitly labelled as legacy or unknown, never as performed
set evidence. Retained session-equipment requirements and performed equipment
snapshots remain omitted unless a later versioned analysis allowlist adds them;
A01 does not export dangling equipment-snapshot identifiers.

The package uses schema `analysis-package/1`, semantic version `repbook-v2/1`,
and canonicalization `repbook-canonical-json/1`. The SHA-256 digest covers the
canonical package core. The exact human-readable JSON shown in preview is the
same byte sequence downloaded by the owner; Repbook makes no provider request
and retains no detailed copy.

Migration `0075_analysis_package_manifest` adds an owner-scoped, privacy-minimal
receipt containing only versions, digest, scope, inventory, source bindings,
creation and evidence-cutoff times, and a maximum 30-day trust expiry. Owner
deletion physically removes the receipt and bindings. Expired or absent
receipts cannot support a later import, and the established privacy-retention
job deletes expired receipts. Recovery manifest 12 classifies these
receipts as operational and excludes them from snapshots and restore, so
recovery cannot revive expired trust. Snapshot schema 30 and historical workout
facts remain unchanged.

A01 does not send the package to an external system, retain provider output,
import analysis, create a recommendation or decision, change Program intent,
rewrite history, or access production. Those later boundaries are separate
owner-gated packages.

## A02 provider-neutral instruction contract

A02 pairs the exact owner-previewed analysis package with deterministic plain-
text instructions. The instructions bind the package ID, namespace, schema,
semantic version, digest, evidence cutoff, expiry, selected question, and
purpose. They work through a paste or file-upload workflow without relying on a
provider-specific system prompt, tool call, API, or hidden behavior.

The instruction contract restates Repbook's fact, intent, calculation,
proposal, decision, adaptation, correction, ownership, and unknown-evidence
meanings. Every package value is untrusted data, even when it resembles a prompt
or tool command. The model is told not to browse, call tools, retrieve omitted
facts, guess a value, collapse evidence classes, claim causality, or describe a
record or Program as changed. Every observation and proposed future action must
cite exact package evidence IDs and state its limitations.

The A02 starter response shape is explicitly human-review-only and cannot be
imported into Repbook. A later package owns the strict typed response and import
boundary. A02 adds no provider request, response retention, durable record,
schema, migration, recommendation, owner decision, adaptation, Program write,
performed fact, recovery obligation, or production action.

## A03 strict typed response contract

A03 replaces the generated starter shape with closed
`repbook-analysis-response` schema `analysis-response/1`. The response must
echo the exact package ID, owner namespace, package and semantic versions,
canonical digest, evidence cutoff, expiry, selected question ID, and exact
question text. Unknown fields at every typed object boundary, incompatible
versions, unbounded text or collections, unsupported measurement units,
duplicate item identities, and evidence IDs outside the bound package fail
closed.

Observations, proposed actions, and unknowns remain separate. Every observation
and proposed action cites bound evidence and states limitations. The only
allowed effect is `review_future_training` with `future_only_review` scope; it
can request later owner review but cannot publish, accept, or mutate anything.
Known history, active-session, ownership, destructive, acceptance, publication,
and production effects are classified as prohibited. Every other effect is
unknown. Both fail validation before a typed response is returned.

Canonical response content gives A04 a deterministic replay boundary: the same
response identity and same content is an idempotent duplicate, while changed
content under that identity is a conflict. A03 itself adds no paste/upload UI,
manifest lookup, durable response, import writer, recommendation, decision,
adaptation, migration, recovery obligation, or Program write.

## A04 untrusted response validation contract

A04 adds a transient paste or local JSON-file path on `/export/analysis`.
The browser keeps the original input only in page state so the owner can retry,
download it unchanged, or deliberately discard it. The request boundary limits
the raw body to 256 KiB, accepts only the closed JSON media types, requires
valid UTF-8, and scans JSON container depth before parsing. The A03 closed
schema then enforces all field, collection, identifier, evidence, unit, version,
and effect limits. Active markup, executable URL schemes, event-handler text,
control characters, and bidirectional display controls fail closed.

The server extracts only the package identity needed to locate the A01 receipt.
The receipt lookup is authenticated and owner-scoped; another owner's identity
is indistinguishable from a missing receipt. Expired, malformed, or deleted
receipts fail closed. Its source bindings reconstruct the exact allowed
evidence-ID inventory without retaining the raw package. The bound current
Program and version must still be current; later Program publication makes the
response stale and requires a new package. Exact question text comes from the
closed question allowlist, while package namespace, schema, semantic version,
digest, evidence cutoff, and expiry come from the receipt.

A validated response is returned only as a plain-text React preview of distinct
observations, unknowns, and future-only Review proposals with exact effects,
evidence, and limitations. No raw HTML is rendered. The server does not log or
retain the response, and A04 adds no response table, import writer,
recommendation, owner decision, accepted adaptation, Program mutation,
migration, snapshot change, or recovery obligation. A05 owns any later
selective durable Review bridge.

## A05 selective external-analysis Review bridge

A05 lets the owner select individual validated observations and future-only
proposals from the A04 preview. One atomic import consumes the temporary A01
manifest, retains a minimal `external-analysis-import/1` provenance receipt in
the existing coaching-insight lifecycle, and creates only the selected pending
Review proposals. The receipt contains selected allowlisted observations,
package and response digests, source bindings, and proposal-to-recommendation
identities; the raw response, unknowns, unselected content, provider metadata,
and model context are not retained.

External observations remain visibly labelled external material. External
proposals use the existing Review, durable defer, reject, owner-decision, and
adaptation lifecycles, but their only accepted effect is an owner-approved
future Review direction. Accept or edit-and-accept records the decision and a
`programChanged: false` adaptation event atomically. It never edits or publishes
the current Program, active workout, or completed history.

Import identity is owner-scoped and idempotent by response UUID plus canonical
response digest and exact selections. Reusing the identity with changed content
or selections is a conflict. Another owner, a missing or expired manifest, a
stale Program, and an interrupted transaction fail without partial writes.
The owner manifest privately binds every included source row with a canonical
content hash and PostgreSQL mutation token; those internal tokens are not part
of the provider-facing package. An owner evidence epoch covers insertions and
collection-membership changes, including an initially empty source class; its
trigger inventory is checked against the same 28-entity allowlist. Validation
and the atomic import claim both fail closed if any allowlisted evidence
changes, disappears, or newly enters scope. After import, the receipt retains
the same bounded evidence state while accounting exactly for the new Review
proposal and its own Program Review-revision transition.
Later Program publication or any bound evidence mutation makes observations
visibly historical and pending proposals non-actionable.

Migration `0076_external_analysis_review_bridge` adds the external-import
identity index, validates the minimal receipt shape, and preserves the pending-
recommendation Program revision guard through a narrow external-proposal path.
Snapshot schema 30 is unchanged. Recovery manifest 13 adds the durable receipt
relationship; privacy sanitization retains only its typed allowlist and restore
validates the full receipt, proposal, owner, and source graph. A stale but
legitimate receipt remains recoverable as historical context; current
actionability still requires exact live evidence. Migration
`0077_external_analysis_restore_compat` preserves the existing stale-preview
race check while bridging the older generic Coach privacy normalization to the
bounded external receipt shape. Migration `0078_analysis_evidence_epoch` adds
the account-root epoch without adding owner data to snapshots or the
provider-facing package.

## A06 adversarial evaluation corpus

A06 adds a provider-neutral, synthetic-only corpus over the complete external-
analysis boundary. Each valid, partial, stale, hallucinated, prompt-injected,
oversized, deeply nested, duplicate, conflicting, cross-user, unknown-exercise,
wrong-unit, unsupported-legacy, mixed-version, unknown-field, and unknown-
effect item owns one deterministic accept, non-actionable, reject, or recovery
oracle.

The focused oracle runs raw request limits, the closed response schema, exact
package binding, and the real A05 import service. A valid import may create only
the selected external receipt and Review proposal and the established Review
revision transition; Program intent, immutable Program versions, active work,
and completed facts remain unchanged. Exact replay is idempotent. Conflict,
cross-user, and stale attempts leave both protected state and the complete
import state unchanged. Unknown fields and effects fail closed.

A06 is verification-only. It adds no runtime path, schema, migration, snapshot
or recovery version, browser behavior, provider call, Program publication,
historical repair, or production action.

## Gauntlet C external-analysis trust gate

Gauntlet C exercises two independent provider-neutral workflows—chat paste and
local JSON file upload—against the real A01 package, A02 instructions, A03
schema, A04 validation, A05 selective import and explicit Review decision, and
A06 adversarial oracles. The checked-in responses are synthetic evaluation
evidence, not provider metadata, owner data, or a claim that model advice is
generally correct.

The owner preview includes the complete validated response object as inert text
alongside the selectable summary. This exposes evidence quality, measurements,
target evidence, requested outcomes, limitations, unknowns, and safety claims
before import. Current instructions accurately direct the owner back through
that exact preview and explicit item selection. Validation alone still writes
nothing; imported proposals remain external and an explicit later Review
decision records only a future direction with `programChanged: false`.

The focused round trip proves useful accepted proposals from both workflows,
deterministic unknown-effect rejection, correction without manifest
consumption, raw-response non-retention, and unchanged Program intent,
immutable Program versions, active work, completed sets, and occurrence facts.
Gauntlet C adds no provider call, schema, migration, snapshot or recovery
version, Program publication, historical repair, or production action.

## Post-v2 interruption-aware active workout

Migration `0079_active_workout_duration_evidence` adds one nullable, constrained
active-duration tuple to `workout_sessions`: semantic version, seconds, and
basis. It does not backfill legacy workouts. `started_at` and `finished_at`
remain the source wall-clock evidence; a normal completion records matching
active time, while a session beyond the three-hour review threshold must record
either owner-reported active seconds or an explicit unknown. A rejected or
incomplete review performs no completion write.

Completed-workout active-duration corrections use the existing owner-scoped
history-revision lock, idempotent mutation identity, record-version and audit
evidence, recommendation reconciliation, and progression reprocessing. They
never change the source timestamps. History, digest, preflight, compiler,
analysis, and export consumers use reviewed active time when present. Legacy
rows and explicit unknown decisions remain unavailable to active-duration
analytics; their elapsed source timestamps are retained only as labelled
wall-clock evidence. Snapshot schema 31 captures and restores the tuple and
upgrades schema 30 rows to explicit nulls. Recovery manifest 14 keeps the same
durable-table inventory while extending the narrow merge contract so restored
duration corrections retain their linked record-version and audit evidence.

The active logging page and completed-workout summary get previous-set evidence from
`getPreviousComparableSets`, not the legacy Program-slot projection. A result
is available only for the same stable exercise ID with complete compatible v1
performed semantics, compatible units and load-entry meaning, one exact linked
working occurrence, and retained machine/cable configuration when required.
Imported Hevy evidence additionally requires the current owner-reviewed
mapping. Unsafe evidence renders an explicit unavailable state; display names
and fabricated fallback values are never used. The exact source workout and
set provenance remain attached to the projection. The same query retains at
most 24 non-null recorded-rest samples from the newest eight compatible
workouts for the pure usual-rest threshold; unsafe rows never enter that sample.

The performed-load draft uses one explicit precedence chain: the latest saved
set in this workout, then the Program target, then the exact previous
comparable set, otherwise blank. The card labels that source. A delayed
comparable read may hydrate only an untouched load field; editing repetitions,
effort, or a note does not block hydration across a server refresh, while any
deliberate load edit does. Cached drafts retain that distinction instead of
treating every unsaved field as a load decision.

The mobile active-exercise card keeps the current set, previous comparable
evidence, required inputs, save/retry state, and next action primary. After an
acknowledgement, focus and scroll reveal the next current set; acknowledged
sets move into a closed `Completed sets` disclosure with correction beside each
saved set instead of a separate receipt panel. Resolved warm-up items likewise
remain available in a completed disclosure. Exercise setup precedes its work
and collapses only after acknowledged work; a queued, retrying, or failed set
cannot make setup disappear. Group work uses a compact mobile summary with the
immutable member order, preparation details, and the next member's read-only
starting-load preview in its native disclosure. The preview uses the same
earlier-workout-set, Program-target, then compatible-history precedence as the
editable set. It explicitly says when no weight entry applies or when no
starting load is available, and never makes a future set editable.
Notes, coaching, form, and replacement controls live in `More for this
exercise`. Pending or failed writes and skipped recovery remain exposed, and
the fixed workout-status bar remains the sole rest/ready/finish authority.
Included day and exercise preparation actions strictly precede every working
set. **Skip due to time** is the direct warm-up action and the detailed
reason flow remains secondary. Once a later working set is recorded, an earlier
warm-up cannot be restored into the live order; retained device blockers route
back to the exact warm-up identity rather than constructing a working-set
target. Superset membership is explicit on every member card. All members in
the active superset start expanded so the complete round can be read by
scrolling, while an owner collapse or reopen remains respected.
An exercise-skip confirmation also retains the exact reason in a session-scoped
recovery pointer. After a Server Action refresh or interruption-time reload, the
runner idempotently reconciles that intent before set logging can resume and
keeps the skipped exercise open until the owner replaces, restores, or
deliberately continues past it. If reconciliation fails, the same exercise
and exact skip reason remain session-scoped recovery state across another
reload. The mobile dock keeps that exercise as its recovery target until the
owner retries the skip or asks Repbook to confirm an unskipped server state and
return to the current set; Finish cannot bypass that choice. Skip and return
commands compare and advance the workout's monotonic history revision, so a
late older request cannot overwrite the newer recovery choice.
Every navigation control that leaves an active `/session/*` route uses a native
document navigation rather than the App Router transition queue. An unresolved
Server Action therefore cannot trap the owner inside the workout. The persisted
recovery pointer and durable device queues survive the same-origin navigation;
the old runner becomes inactive on page hide, and a newly mounted runner
reconciles the exact session before logging or Finish can resume. Navigation
outside an active workout keeps the ordinary client-side path.

Active-workout mutations that can otherwise occupy Next.js's sequential
document action channel have a bounded acknowledgement wait. Set logging,
equipment selection, occurrence mutation, exercise skip reconciliation,
extra-set creation, and Finish retain their exact device command or recovery
pointer before dispatch. If the server does not answer within the deadline,
Repbook releases its local queue lock, stops same-document retries, and requires
a native reload before idempotently replaying the same identity. Extra-set and
Finish commands also retain their exact occurrence or note, fatigue, and
duration input. A storage failure sends nothing. Finish remains blocked while
recorded work or an unreadable recorded-work copy is unresolved; a verified
foreign owner/session copy remains separate and non-blocking.

Rest alerts default to foreground sound for a new device, while an explicit
visual-only choice remains preserved locally. Logging a set primes Web Audio
during the owner gesture, and the active timer names its current alert mode.
Sound-enabled foreground timers use a local audible tick at 10 and each
remaining second, followed by a stronger multi-second finish alarm.
Visibility changes, page restoration, focus, and active-workout rehydration
reconcile the absolute deadline immediately. Resume during the final seconds
does not replay missed ticks; resume after expiry claims at most one final cue.
While a running timer is visible, a feature-detected Screen Wake Lock is
requested, reacquired after revocation or visibility return, and released on
completion, cancellation, or unmount. Wake Lock rejection never changes timer
truth. Browser suspension after manual iPhone lock, device volume, silent mode,
Bluetooth, and background restrictions remain external constraints; Web Audio
cannot guarantee a lock-screen alarm and the visual expired state is always the
truthful fallback.

Removing a workout exercise affects only that stable session-exercise row.
Completed sets remain historical evidence, the Program remains unchanged, and
Undo restores the exact retained pre-removal state, including `added` for a
workout-only exercise rather than reclassifying it as planned work.

The runner reconciles refreshed occurrence props by stable ID and monotonic
revision because a Next.js refresh may preserve Client Component state. A
device-side occurrence remains visible while its exact durable command owns it,
including the brief interval when a Server Action's refreshed RSC tree arrives
before the client removes and acknowledges that command. A newer acknowledged
local revision also remains visible while its receipt owns it; discarding a
device command lets refreshed server truth win. An ordered-set rejection retains
the exact authoritative blocking occurrence with the later attempt. The blocker is named and directly
reachable, retry stays locked until that occurrence is resolved, and deliberate
discard of the later attempt remains available. Legacy retained set commands
without this newer context remain readable and recoverable. Finish is a
full-height review mode with recorded-work blockers first; equipment guidance
remains explicitly non-blocking. Destructive active-workout exit may remove only
readable device copies that match both the authenticated owner and the exact
session. Quarantined, unreadable, foreign-session, and foreign-owner copies stay
in their separate review trays. Both device queues are locked and re-read at
confirmation, so copies added while the dialog was open cannot be orphaned.
Exact-copy removal rolls back byte-for-byte if local storage or server
abandonment fails, so the UI never reports a discard that was only partially
applied. The server also distinguishes an idempotent
already-abandoned retry from a workout completed elsewhere; the latter rejects
abandonment and restores the device copies. None of these presentation and
recovery rules change Program intent, stored workout ordering, completed
History, schema, or migration boundaries.

## Post-v2 retained workout-equipment preparation

Migration `0080_session_equipment_requirements_snapshot` adds one nullable,
versioned equipment-requirements snapshot to each `session_exercises` row. New
planned, compiled, added, and substituted workout exercises retain the exact
source exercise and requirement identities, broad equipment type and minimum,
reviewed definition identity and label, and exact profile, attachment, and
geometry predicates. Existing rows remain null and explicitly unknown; there
is no backfill from the mutable exercise catalogue and no completed-history
rewrite. Substitution versions the old and new requirement meaning, and undo
restores the corresponding retained snapshot with the exercise identity.
Ordinary updates cannot mutate a retained tuple for an unchanged exercise;
owner-authorized snapshot and record-version restores are the audited
exceptions.

The active-workout preparation projection is owner-scoped and reads only that
retained requirement meaning. Current saved inventory and reviewed equipment
profiles may answer availability, but display names never establish identity.
Availability is green only when every retained session exercise has one
coherent executable setup: all broad requirements are present, one primary
item satisfies every same-type predicate, and its exact profile, geometry, and
compatible attachment predicates also match. Independently available but
mutually incompatible items therefore remain attention as `No compatible
saved setup`, not false coverage or a false claim that the saved items are
missing. A saved broad item such as a cable station therefore establishes
presence even when its exact reviewed geometry is incomplete; exact attachment
and profile requirements remain strict stable-identity checks.

The projection is fenced to the expected workout history revision and to an
evidence digest covering the retained exercise rows and saved inventory/profile
tables before and after its reads. A concurrent add, substitution, restore, or
inventory change returns an explicit updating state and withholds straddled
requirements. Legacy, malformed, unsupported, or partially retained evidence
remains visibly unknown.

Today shows the compact stable-ID-deduplicated equipment preflight before Start.
Once acknowledged work or a retained device set exists, the active workout no
longer repeats that global inventory panel; exercise-local exact setup remains
available where it is actionable. The list describes saved inventory coverage,
not whether the owner physically gathered anything, and creates no
preparation-complete fact.
Unknown, unavailable, and incompatible rows stay visible and never block the
workout. Exact load, plate, stack, attachment, and geometry guidance remains
exercise-local and uses the retained prescribed target when available, so a
reviewed bar or plate-loaded machine can show setup-stage plate math before the
performed value is entered. When more than one available plate combination
loads the exact same weight, the plate engine minimizes plate count first and
then prefers heavier denominations, while still respecting the retained plate
inventory. Only the current exercise and unknown, unavailable, incompatible,
pending, failed, or stale setup evidence stays expanded, while ordinary future
setup panels use keyboard-native disclosure.

Routine import does not silently choose between materially different loading
variants that share a family label. An unqualified name such as `Lat Pulldown`
requires the owner to select the stable cable or plate-loaded identity; explicit
variant names remain deterministic. This affects future Program publication
only and never rewrites an active workout or completed History.

Progression remains proposal-only. A load increase requires the configured
number of exact planned exposures with one explicit non-grinding effort signal
per set: RPE 8 or lower, or RIR 2 or higher, never both. A blank Program target
may use one exact repeated performed load as its baseline; mixed loads,
workout-only extra sets, missing effort, contradictory effort, or retained
prescription snapshots that differ from the current sets, rep range, or target
load fail closed. Review explains the evidence, and only explicit approval may
publish a future Program version; the active workout and completed History are
never rewritten.

Snapshot schema 32 round-trips the retained tuple and upgrades schema 31 rows
to explicit null evidence. Recovery manifest 14 keeps the same durable-table
inventory while extending the existing `session_exercises` lifecycle field
contract. Restore and record-version paths validate exercise identity and do
not infer missing meaning. A pre-0080 exercise version that omits the tuple
retains the current frozen tuple only when the exercise identity is unchanged;
if it restores a different exercise identity, the equipment meaning becomes
explicitly unknown.

## D01 structured redacted diagnostics

D01 replaces arbitrary server log events with one server-only diagnostic
boundary in `src/lib/server-log.ts`. Its manifest owns every permitted event
name and fixes each event's level, component, operation, coarse state, and
exact field validators. TypeScript rejects undeclared call-site shapes, and the
runtime independently refuses unknown events, extra or missing fields, and
invalid enum or numeric values without writing a partial event.

Every accepted event carries the application version, diagnostic schema and
redaction versions, timestamp, a 24-hour retention expiry, and a random
episode correlation value. A correlation value is never derived from an owner
or record identifier, is valid for at most 15 minutes, and becomes `null` when
an explicitly supplied episode has expired. Raw exceptions are mapped only to
a closed error category; provider failures first pass through the separate
provider-error sanitizer.

The application does not create a diagnostic database or retain a diagnostic
bundle. Its stdout sink must discard D01 events no later than their recorded
expiry. D01 adds no schema, migration, snapshot, recovery-manifest, browser,
support-bundle, upload, Program, workout, or performed-fact path.

## D02 owner-previewed support bundle

D02 adds a separate authenticated workspace at `/export/support`. The owner
selects one closed problem and one coarse observed outcome. Each problem owns
an exact context allowlist: workout start and Coach/Review availability may use
only connection state; display problems may use only coarse browser family and
viewport class; export/recovery problems may use only coarse browser family
and download capability. The full browser string, locale, timezone, account or
record identity, workout contents, and D01 log lines are never included or
retained.

The bundle uses schema `support-bundle/1`, redaction version
`support-redaction/1`, and a random per-bundle correlation UUID. Coarse browser
context can be removed after preview. Owner-written text is a separate section,
off by default, limited to 500 display-safe characters, and visibly labelled
as potentially containing private training or health detail. An unavailable
browser-context collector records only the closed `runtime` category; no raw
exception enters the artifact.

The client generates the complete JSON in memory. The exact preview bytes are
the exact deliberately downloaded bytes. There is no route handler, server
action, fetch, upload, storage, diagnostic-log read, analysis-package reuse, or
automatic provider transmission. The artifact creates no durable entity,
receipt, migration, snapshot, recovery, Review, Coach, Program, workout, or
performed-fact obligation.

## Training reporting V2

Training reporting is a deterministic, versioned projection over retained
workout evidence. The occurrence ledger and performed-set rows remain the
source records; the report never rewrites a completed session, changes the
Program, or turns a Coach proposal into a fact. `src/lib/training-report.ts`
owns reporting facets, coverage gates, duration adherence, confidence, warm-up
compaction, and Coach-summary rule contracts. `src/services/digest.ts` builds a
coherent owner-scoped evidence projection and renders the external brief in
this order: Coach Summary, compact session summaries, period analysis, and a
detailed derivation appendix. History and Coach use the same all-planned target
denominator rules; a supported subset percentage cannot become an overall
attainment claim unless its coverage, sample-size, and session-span gates pass.

Migration `0083_reporting_session_outcomes` adds nullable, versioned tuples for
the Program duration frozen at Start, terminal session completion meaning,
structured skipped/ended occurrence causes, and the bounded prescribed
counting-basis evidence supported by current writers. Current standalone Quick
Log and unlinked retrospective entries are explicitly `completed_without_prescription`;
they are not relabelled as plan changes or legacy unknowns. New terminal writes use
canonical causes for time limit, fatigue, pain/discomfort, equipment, user
choice, technical/app issue, interruption, and Program change. Elapsed time
never selects a cause. A workout with remaining planned work requires the
owner to choose one cause, and the same retained finish command replays by exact
payload identity. Planned-duration and finalized completion meaning are
immutable outside the authorized snapshot-restore path.

Migration `0084_restore_finish_command_receipts` extends the existing guarded
snapshot-restore wrapper so a schema-35 full or history restore also preserves
the one owner-scoped `session.complete` receipt that proves the exact active
Finish payload committed for a versioned completed workout. Restore validates the
receipt against the retained completion tuple, merges rather than replaces
destination audit history, and rejects missing, cross-owner, stale, duplicate,
or contradictory receipts. This keeps exact retry and changed-payload conflict
semantics intact after recovery. Completed-without-prescription and reviewed
retrospective writers use their own existing idempotency/provenance contracts
and do not manufacture an active-Finish receipt. The migration does not add a
new table or reinterpret an older workout that has no versioned completion
tuple.

The prescribed-counting writer is deliberately conservative. It freezes
`not_applicable` only when a current Program Start or accepted compiler proposal
proves a non-unilateral loaded or assisted repetition prescription. Older rows,
unilateral work, plain/bodyweight repetitions, and duration holds remain
explicitly unknown unless a future owner-facing writer stores total, per-side,
alternating-total, or hold meaning. Reports keep their raw values visible, state
the missing basis, and exclude unsupported target/progression conclusions.

Independent manual activities retain exact duration seconds. The current
activity form accepts whole minutes or minute-and-second precision and submits
exact seconds; the action continues to accept the earlier whole-minute request
shape for cached-client compatibility, but rejects both representations in one
request. This changes no table or snapshot contract. Activity detail and the
training brief preserve a non-minute remainder rather than rounding it away.
An empty past History date opens a truthful choice between a retrospective
workout and an independent activity. Activity entry retains the selected date
and calendar return context but leaves its start time blank until the owner
enters it. Recent non-archived manual activity names are optional shortcuts:
selecting one copies only its generic activity type and title, never prior
duration, distance, intensity, or other measurements. A named Power Walk
therefore remains a `walk` activity with a reusable title, not a separate
stored activity type.

Retrospective performed-set duration remains a different fact from workout
active duration. The retrospective UI directs a standalone timed activity to
`/activity/new` and labels exercise duration as a set measurement. Recording a
timed set does not populate, sum, correct, or backfill the session
`active_duration_*` tuple. A genuine retrospective workout can still use its
separate exact-start and optional workout-duration controls; unknown session
duration remains excluded from duration analysis.

`reporting-exercise-family/1` groups frozen exact variant labels into broad
movement families only for exposure context. Exact exercise identity remains
the progression, target, trend, and record unit. Current substitutions or
workout-only additions whose performed label/family meaning was not frozen are
`Unclassified`; mutable catalog metadata cannot silently reinterpret their
history. Legacy performed rows and missing outcome ledgers remain visible with
unknown plan linkage and cannot improve coverage.

Family-level volume is a separately covered reporting facet, not a raw sum of
every set. It normalizes only supported, calculation-eligible loaded sets into
the owner's configured unit, reports eligible retained-set rows over all
retained rows, and excludes non-load, legacy, substituted/unclassified, or
counting-basis-unknown evidence from the numeric total. Family volume never
merges exact variants for progression, targets, records, or top-set trends.

Snapshot schema 35 adds the new tuples as explicit null unknowns when upgrading
schema 34 and validates their row and cross-table coherence on restore. It also
captures the durable Finish receipt for versioned completed workouts so a
restored client command can be reconciled exactly. Recovery manifest 15 keeps
the same table inventory while extending its field obligations. Analysis-package
schema 1 intentionally excludes these additive report-only columns from its
version-1 row hash so a metadata-only migration does not stale an otherwise
unchanged manifest. The unversioned set CSV remains unchanged.

Warm-up detail expands from evidence the current recorder actually retains:
notes, structured pain/equipment causes, and explicit workout-only/change
origin. The current schema has no independent performed warm-up load/failure
measurement, so the report does not infer unusual load or failure by mining
free text; an explicit note remains visible verbatim.

The owner-facing download workspace is purpose-first without changing any
recovery or analysis-package artifact contract. The primary Complete AI report
assembles one unbounded view of available non-archived training evidence. It
combines the readable coaching brief with a report-only JSON source appendix
that preserves retained workout, set, occurrence, equipment-snapshot,
activity, pain, fatigue, AI-visible note, recommendation-decision, and saved
user-authored Live Coach fields. Revision-tracked evidence is accepted only
after a matching start/end revision check; session notes and saved user
messages are labeled retrieval-time supplemental context. Account identity,
archive metadata, private notes, raw assistant/provider material, request/retry
keys, and worker identifiers remain excluded. The route prepends deterministic
provider-neutral review instructions and returns a private no-store Markdown
response. Only an explicit browser tap may copy those exact bytes to the device
clipboard; Repbook does not transmit the report to an external provider. The
bounded Training Brief remains available for a chosen period, the canonical
full JSON backup remains the recovery copy, and raw CSV, versioned
analysis-package, and redacted support-bundle workflows
stay distinct under Advanced exports. An all-time History link still never
silently changes the bounded Training Brief: the workspace explains and selects
the 12-week default for that separate artifact.

## R01 cross-cutting lifecycle audit

`src/services/recovery-manifest.ts` remains the only durable-table inventory.
Recovery manifest 15 classifies every migrated base table exactly once and owns
account scope, archive/permanent-delete behavior, capture, restore ordering,
retention, and integrity checks. R01 does not duplicate that table registry.

`src/lib/v2-lifecycle-audit.ts` adds the narrower semantic-field audit required
for v2 hardening. It maps Program intent and versions, active plan snapshots,
occurrences, performed sets, correction lineage, independent activities,
progression inputs, Review proposals, owner decisions, accepted adaptations,
external-analysis receipts, device queues, diagnostics, and support bundles to
exact creation, read, correction, archive/delete, import/export, snapshot,
restore, rollback, sign-out/device, diagnostic, Review, Coach, and recovery
owners. Each non-applicable lifecycle requires an explicit bounded reason.

Database introspection rejects an audited table or field absent from the exact
migrated schema. Consistency tests reject a table absent from recovery manifest
15, a missing lifecycle owner, an unexplained exclusion, a device queue absent
from the sign-out inventory, or an implemented product package still marked as
future. The audit exposed and corrected that last case for the already-live A05
selective import bridge and the omitted D01 implementation marker. R01 adds no
schema, migration, writer, runtime log,
owner-data path, snapshot shape, or recovery-manifest version.
