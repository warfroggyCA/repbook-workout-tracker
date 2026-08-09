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

A set is still pending while its write is saving, retrying, or failed. Only a
server acknowledgement advances workout guidance or exposes correction. The
client keeps a stable command identity across retry, the service accepts an
identical replay without duplicating evidence, and reuse of that identity with
different evidence fails closed. Older outbox formats are quarantined for
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

Free-text day and exercise warm-up overviews are reference guidance. Only an
authored structured warm-up item creates a checkable occurrence, and normal,
compiled, and retrospective workout producers use the same boundary. The
active workout and History show the structured action once; they do not repeat
the same item inside exercise guidance. Existing overview projections remain
readable but are not silently converted into performed or skipped evidence.
Known pending projections retained by the conservative legacy backfill are
excluded from active controls and rejected at the mutation boundary without
rewriting the stored row; independently authored structured actions remain
actionable.

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
next work. Pending occurrences retain their authored sequence across warm-ups,
working sets, extras, skips, retries, and corrections; expanding or collapsing
an exercise card cannot reorder them. A saving, retrying, or failed set remains
current until the server acknowledges its exact command. Once no pending
occurrence remains, the session is ready to finish but is not completed until
the owner explicitly chooses Finish workout.

Rest is a first-class, device-durable focused action created only after the
exact source occurrence and completed set are acknowledged. Its source identity
survives reload and background return, while the next ledger occurrence remains
visible as next work. Saved occurrence evidence classifies positive rest as
straight-set, between-member, or between-round rest. Zero means explicitly no
rest, null means unknown rest, and an absent field on a retained legacy command
means that command must not replace or clear an existing timer. A positive,
zero, or null rest decision changes the device timer only after acknowledgement.

Group, member, and round progress is derived from the same occurrence outcomes,
not from a second execution state. Fully performed work is resolved; a fully
settled mix containing skips, abandonment, or limited evidence is
resolved-with-changes. T05 adds no historical rewrite or migration and does not
reinterpret unsupported legacy evidence.

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
expanded card immediately offers two explicit recovery branches: replace the
exercise for this workout or continue without replacement. Replacement restores
only still-unperformed working-set occurrences that the exercise skip resolved;
an already acknowledged warm-up skip stays intact. The replacement, continuation,
and un-skip paths leave the saved Program and completed sets unchanged and retain
44-pixel touch targets.

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
set evidence. Performed session-equipment snapshots remain omitted until their
separate semantic preparation is complete; A01 does not export dangling
equipment-snapshot identifiers.

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
Later Program publication or correction of revision-bearing source evidence
makes a pending external proposal stale before acceptance.

Migration `0076_external_analysis_review_bridge` adds the external-import
identity index, validates the minimal receipt shape, and preserves the pending-
recommendation Program revision guard through a narrow external-proposal path.
Snapshot schema 30 is unchanged. Recovery manifest 13 adds the durable receipt
relationship; privacy sanitization retains only its typed allowlist and restore
validates the full receipt, proposal, owner, and current-Program graph.

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

## R01 cross-cutting lifecycle audit

`src/services/recovery-manifest.ts` remains the only durable-table inventory.
Recovery manifest 13 classifies every migrated base table exactly once and owns
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
13, a missing lifecycle owner, an unexplained exclusion, a device queue absent
from the sign-out inventory, or an implemented product package still marked as
future. The audit exposed and corrected that last case for the already-live A05
selective import bridge and the omitted D01 implementation marker. R01 adds no
schema, migration, writer, runtime log,
owner-data path, snapshot shape, or recovery-manifest version.
