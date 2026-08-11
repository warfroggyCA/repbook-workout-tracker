# Security and public privacy boundary

The repository is public, but the application is designed for private workout
data.

## Safe to publish

- application source and additive migrations
- synthetic tests and fixtures
- public architecture and development contracts
- pull-request verification that uses local, disposable databases

## Kept private

- real workout or health observations
- owner names, email addresses, exports, screenshots, and account metadata
- production response bodies, maintenance counts, and exact operational times
- secrets, OAuth credentials, database URLs, snapshot keys, and provider tokens
- deployment identifiers, database branch identifiers, retained checkpoints,
  and detailed release chronology

Production-maintenance workflows intentionally remain in the private operations
repository. Public Actions must not call production maintenance endpoints.

## Application rules

Secrets remain server-only. Authenticated resources enforce ownership on the
server. User-specific responses are not shared-cacheable. Logs and client error
messages are redacted. Imports, exports, snapshots, restore, archive, and
permanent deletion validate authorization and preserve audit boundaries.

Active-workout equipment preparation is also owner-scoped. New workout
exercise rows retain the reviewed equipment-requirement identities needed to
interpret that workout later; they do not record whether equipment was
physically gathered. Current inventory supplies availability only and cannot
replace missing retained meaning. Legacy and malformed evidence stays unknown,
cross-owner sessions are indistinguishable from missing sessions, and a
concurrent workout revision withholds stale preparation rows. Snapshot schema
32 and record-version restore preserve this tuple under the existing private
owner backup boundary; public tests use synthetic identities and inventory.

Versioned analysis packages are prepared only after an authenticated,
same-origin owner request. The server allowlists purpose-bounded fields and
omits account identity, raw provider or AI material, private contextual notes,
operational data, and recovery material. The exact package is previewed and
downloaded locally without automatic provider transmission or detailed server
retention. Repbook stores only a digest-and-source receipt with a maximum
30-day trust window; owner deletion physically removes it. These operational
receipts are excluded from snapshots and restore, and the existing privacy-
retention job deletes them at expiry. The question-specific allowlist omits
unneeded domains, and retained session-equipment requirements and performed
equipment snapshots stay outside the package unless a separately versioned
analysis allowlist deliberately adds them.

Provider-neutral model instructions are generated locally from the exact
previewed package identity and digest. They treat every package value as data,
forbid embedded instructions, browsing, tool use, guessed facts, direct
mutation claims, and requests for omitted information, and require exact
evidence IDs plus limitations. Repbook does not send the package or instructions
to a provider. The owner remains responsible for reviewing the external
provider's privacy and retention settings. A02 retains no response and exposes
no import path.

External responses use closed `analysis-response/1`. Validation binds the exact
package ID, owner namespace, versions, digest, evidence cutoff, expiry, question,
evidence IDs, supported measurement units, bounded text and collections, and
one review-only future effect. Extra or executable content, prohibited or
unknown effects, cross-package evidence, and conflicting identity reuse fail
closed. A03 itself performs no upload, manifest lookup, persistence, logging, or
mutation.

The A04 paste/file validator treats the returned JSON as hostile. The browser
and server cap it at 256 KiB; the server accepts only JSON media, requires valid
UTF-8, limits nesting before parsing, and rejects active markup, executable URL
schemes, event-handler text, control characters, and display-direction controls.
Authentication and owner scope are rechecked at the route and receipt lookup;
cross-owner package IDs return the same boundary as missing receipts. Deleted,
expired, malformed, or stale-Program receipts cannot validate a response.

React renders the validated preview as ordinary text without raw HTML. The
original input remains transient browser state for deliberate recovery download
or discard and is neither echoed in an error nor retained or logged by the
server. A04 performs no import and creates no recommendation, decision,
adaptation, Program write, migration, snapshot content, or recovery record.

A05 import repeats same-origin authentication, owner-scoped manifest lookup,
bounded UTF-8 JSON, and the complete closed response validation before any
write. The owner must select each imported item. One transaction consumes the
temporary manifest and writes a minimal typed receipt plus selected Review
proposals, so an injected or concurrent failure cannot leave a partial import.
The raw response, unknowns, unselected material, and provider or model details
are discarded. Response identity replay is idempotent only for the same
canonical content and exact selections; changed reuse conflicts.

Snapshot sanitization allowlists the minimal receipt and restore validates its
owner, response identity, proposal mapping, and current Program relationship.
Acceptance rechecks source revisions and Program identity atomically. It records
only an explicit owner decision and future Review direction and cannot change a
Program, active workout, or completed fact.

A06 keeps its entire adversarial corpus synthetic and provider-neutral. Raw
size/depth attacks, active text, guessed facts, unknown identifiers, units,
fields and effects, mixed versions, cross-owner attempts, stale receipts, and
conflicting replay all have deterministic fail-closed or recovery oracles.
Stateful cases assert that rejected or recovery input leaves both protected
workout/Program state and the import lifecycle unchanged. No provider response,
owner identity, or operational evidence is checked into the corpus.

Gauntlet C retains only two synthetic provider-neutral response fixtures and
their workflow labels; it records no provider, account, or model metadata. The
complete validated response is rendered as inert owner-preview text before
selection, while the original bytes retain the existing transient recovery or
discard boundary. The real import and explicit approval proof stores only the
established allowlist and `programChanged: false` future Review direction. It
does not transmit a package, retain unknown or unselected response content, or
change Program, active-workout, or performed facts.

D01 diagnostics use a closed, versioned server-side vocabulary. Event callers
cannot add arbitrary fields, and runtime validation refuses unknown event
names, unknown or missing fields, and invalid values before output. The
allowlist omits owner and record identifiers; weights, reps, exercise names,
training dates, notes and pain or health content; tokens and secrets; raw error
names, messages and stacks; provider request or response bodies; and complete
rows. Provider failures retain only the established categorical sanitizer.

Correlation is a random UUID for a bounded 15-minute episode, never a durable
owner identity. Each line declares a maximum 24-hour expiry. The application
does not persist D01 events, and any runtime log sink is required to delete or
expire them by that timestamp. D01 does not add a support-bundle generator,
download or upload path, owner-data access, or production-maintenance action.

D02 support bundles are a different artifact and never read or repackage D01
stdout. The client starts from one selected problem and filters coarse browser
context through that problem's closed allowlist. It automatically reads no
workout or health facts and omits raw user-agent text, locale, timezone, stable
owner and record identity, provider material, secrets, and rows. A random
correlation exists only in the generated file and is not retained by Repbook.

Optional coarse context can be removed from the exact preview. Optional owner-
written text is off by default, bounded, rejects display-control content, and
is plainly marked as potentially private. Preparing or downloading the bundle
makes no API, upload, AI, or storage request. The separate `support-bundle/1`
artifact has no import path and cannot be reused as an analysis package,
diagnostic event, performed fact, proposal, decision, or adaptation.

R01 treats lifecycle omission as a trust failure. Every v2 semantic field
family has one explicit owner for authorization-sensitive creation and reads,
correction, archive/delete, portability, snapshot/restore/rollback, device
queues, diagnostics, Review, Coach, and recovery. A non-applicable boundary
must explain why no data crosses it. The audit contains module names and
synthetic contracts only; it does not inspect, log, export, or add owner data.

The existing recovery manifest remains the single durable-table inventory, and
the existing sign-out inventory remains the single device-command inventory.
R01 tests cross-check those owners instead of creating another runtime copy.
Diagnostics and local support artifacts stay explicitly outside snapshots,
recovery, AI analysis, Review, and Coach.

Security reports use the private process in `SECURITY.md`; public issues must
contain synthetic data only.
