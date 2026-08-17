# Codebase architecture review

A reverse-engineered map of the application as built, the structural problems that
map exposes, and a sequenced plan to address them.

This document is an assessment, not a contract. [ARCHITECTURE.md](ARCHITECTURE.md)
remains the authoritative statement of system ownership and persisted-data
contracts; nothing here proposes changing a documented behaviour or data contract.
Every recommendation below is behaviour-preserving.

Reviewed at commit `6456cc1`. All counts were measured directly from the working
tree at the time of writing.

## Contents

- [Summary](#summary)
- [The architecture, as built](#the-architecture-as-built)
- [The hot path, end to end](#the-hot-path-end-to-end)
- [Findings](#findings)
- [Refactoring strategy](#refactoring-strategy)
- [Suggested code](#suggested-code)
- [Scorecard](#scorecard)

## Summary

| Measure | Value |
| --- | --- |
| Application source | 153,626 lines across 671 files |
| Test source | 121,191 lines (273 unit specs, 56 browser specs) |
| Pages / API routes | 38 / 26 |
| Server action modules | 23 files, 5,812 lines |
| Services | 88 files, 51,581 lines |
| `lib` modules | 125 files, 29,062 lines |
| Client components | 108 of 138 component files |
| Schema | 68 tables, 21 modules, 83 additive migrations |
| Raw SQL template literals | 634 |

This is a disciplined codebase carrying one load-bearing constraint that has
deformed the code around it. The data contracts in `AGENTS.md` are rigorous,
migrations are additive and replayed in CI, and the domain separation between
Program intent, performed evidence, and coaching proposals is held consistently.

The constraint is stated in a comment in `src/db/index.ts`:

> Interactive transactions are avoided app-wide because neon-http does not
> support them.

Most findings below descend from that sentence. With no transactions, atomicity
had to be bought elsewhere, and it was bought by collapsing multi-step domain
operations into single large SQL statements. That is why one function is roughly
1,100 lines, why equipment-compatibility rules live inside `jsonb_array_elements`
subqueries, and why one rule is now implemented twice — once in TypeScript and
once in SQL.

The codebase already contains its own counter-example: `src/services/progression-jobs.ts`
opens a `neon-serverless` pool and uses real transactions. The remedy is an
existing in-repo pattern applied more widely, not a new one.

## The architecture, as built

Six nominal layers. Three have porous boundaries.

| Layer | Size | Assessment |
| --- | --- | --- |
| `src/app` routes | 38 pages, 26 API routes | Route groups split `(main)`, `(setup)`, `(acceptance)`, `(simulation)`. |
| `src/app/actions` | 23 files, 5,812 lines | Authenticated mutation boundary: auth, Zod validation, service call, cache invalidation. 8 modules import schema directly. |
| `src/services` | 88 files, 51,581 lines | Domain behaviour and persistence. 12 modules contain no database access and belong in the pure layer. |
| `src/lib` | 125 files, 29,062 lines | Nominally pure shared logic. 7 modules import the database; 8 import services, inverting the dependency. |
| `src/engine` | 9 files | Plate maths, load selection, equipment filtering. Verified pure — no database or service imports. The cleanest layer in the repo. |
| `src/db/schema` | 21 modules, 68 tables | Drizzle definitions plus 83 additive migrations. 148 index declarations, 43 of them in `session.ts`. |

## The hot path, end to end

Logging one set is the operation that matters most: it happens on a phone,
mid-exercise, often on poor signal.

1. `components/session/exercise-card.tsx` (4,040 lines) captures the set and mints a client UUID.
2. The entry is queued into `localStorage` by `lib/workout-set-outbox.ts`, guarded by a Web Locks mutex for cross-tab safety.
3. `components/session/session-runner.tsx` (4,584 lines) renders the set as pending before any network call.
4. `components/session/workout-set-outbox-sync.tsx` (1,112 lines) drains the queue and invokes the server action.
5. `logSet` in `app/actions/sessions.ts` validates with Zod, then resolves the user through a process-local id cache rather than a full profile read. It deliberately skips cache invalidation to keep the path fast.
6. `logWorkoutSet` in `services/session-lifecycle.ts` validates semantics in TypeScript, then delegates to `logWorkoutSetAttempt`.
7. A single SQL statement of roughly 1,100 lines with 9 materialised CTEs locks rows `FOR UPDATE`, revalidates ownership, checks equipment compatibility, enforces set ordering, and writes set, occurrence, and pain rows atomically.
8. The outcome union flows back; the outbox marks the entry saved or schedules a retry on a fixed six-step backoff.
9. Progression evaluation is queued as a job rather than run inline — the one place real transactions are used.

Step 7 is why the app survives a dropped connection mid-set without corrupting
history. The offline-first design is correct; the concern is its implementation
medium, not its intent.

## Findings

Eighteen findings, grouped by class and ordered by severity within each group.

### Architecture

#### A1 — Transactions are disabled app-wide, so domain logic migrated into SQL

**Critical.**

- `src/db/index.ts` selects the neon-http driver, which cannot hold an interactive transaction.
- `services/session-lifecycle.ts` is 3,801 lines and contains 51 materialised CTEs.
- `logWorkoutSetAttempt` spans lines 2188–3299: roughly 1,111 lines in one function.
- `startWorkoutSession` spans lines 1300–2116: roughly 816 lines in one function.

Because the driver cannot hold a transaction across statements, atomicity is
achieved by fusing whole operations into single statements. Genuine business
rules now live in SQL: whether a cable attachment is compatible with a selected
stack, whether a plate-loaded machine's entry meaning matches its geometry
snapshot, which earlier pending set blocks the current one. These rules cannot be
unit-tested in isolation, cannot be stepped through in a debugger, and are
invisible to the type system.

**Fix.** Adopt `neon-serverless` (WebSocket pool) as the standard driver. The
repository already does this in `services/progression-jobs.ts` and it works. That
single change restores `db.transaction()`, which lets the large statements
decompose into readable, individually testable TypeScript steps with identical
atomicity guarantees.

#### A2 — Thirty of thirty-eight pages query the database directly

**High.**

- 30 of 38 `page.tsx` files import `@/db` or schema tables.
- `app/(main)/session/[id]/page.tsx` imports 14 schema tables and assembles props inline.

Read logic is duplicated between pages and services, so there is no single place
to add caching, tune a query, or change a projection. Presentation files also
carry persistence knowledge, which is part of why the two largest page files are
hard to modify safely.

**Fix.** Introduce one read-model function per route (for example
`getSessionPageModel(db, userId, id)`) in `services/`, returning exactly the props
the page renders. Pages reduce to an `await` plus JSX. The change is mechanical
and behaviour-preserving.

#### A3 — The `lib` / `services` boundary has no enforced meaning

**Medium.**

- 7 `lib` modules import the database.
- 12 `services` modules contain no database access.
- 8 `lib` modules import from `services`, inverting the dependency.
- 25 files carry `server-only`, against roughly 100 server modules.

New code has no rule to follow, so the split widens arbitrarily. The
`server-only` gap is the sharper edge: server modules without that marker can be
pulled into a client bundle by one stray import, and the type system will not
object.

**Fix.** Rename to intent — `lib/` strictly pure and isomorphic, `domain/` for
database-touching behaviour. Add `server-only` to every module in the latter, and
an ESLint `no-restricted-imports` rule forbidding `lib/ → domain/`.

#### A4 — Four competing result idioms at the same boundary

**Medium.**

- Thrown `Error`: 333 sites in services.
- `{ ok: true | false }`: 313 sites.
- `{ outcome: "..." }` unions: 169 sites.
- `actionFailure(code, message)`: 36 sites in actions.

Callers must know which of four shapes a function returns, and the compiler
cannot warn when a caller handles the wrong one. Thrown errors in particular
cross the server-action boundary as opaque digests in production.

**Fix.** Standardise on the discriminated `{ outcome }` union, already the
richest idiom and the best suited to this domain's many partial-failure states.
Reserve `throw` for programmer error. Migrate per module, not in one pass.

### Duplicate logic

#### D1 — Five hand-copied offline outboxes, already drifting apart

**Critical.**

- 4,427 lines across 5 outbox modules, plus 2,345 lines across 4 sync components.
- `nextRetryDelayMs` is byte-identical in 4 files.
- `browserStorage()` is byte-identical in 5 files.
- The same constants are re-declared: `MAX_ENTRIES = 100`, `MAX_AUTO_ATTEMPTS = 6`.

Each queue re-implements the same state machine: parse, enqueue, cap, mark
syncing, mark transient failure, back off, quarantine, retry, discard, evict by
owner.

The duplication has already produced a behavioural split. When the Web Locks API
is unavailable, `withLiveCoachOutboxLock` runs the task unlocked, while
`withContextualNoteOutboxLock` throws. Identical abstraction, opposite safety
semantics, and nothing forces anyone to notice.

**Fix.** Extract one generic `createOutbox<TPayload>()` factory parameterised by
storage key, lock name, caps, and a payload codec. The five modules become thin
configuration files.

#### D2 — Set-metric semantics implemented twice, in TypeScript and in SQL

**Critical.**

- `lib/set-metric-semantics.ts`: 943 lines of TypeScript.
- `lib/set-metric-semantics-sql.ts`: 317 lines of SQL builders.
- Paired functions: `classifyPrescriptionOutcome` / `prescriptionOutcomeSql`,
  `recomputeRestoredTargetMet` / `restoredTargetMetSql`,
  `setMetricExclusionLabel` / `setMetricExclusionReasonSql`.
- `services/history-report.ts` imports both.

These rules decide whether a performed set counts as evidence, whether a target
was met, and whether a set is excluded from analytics — conclusions that feed
progression, history, and exports. Two implementations of one rule will drift;
when they do, the same set will be judged differently depending on whether the
answer came from a query or from application code. `AGENTS.md` explicitly forbids
this: *avoid duplicated interpretations of the same fact.*

**Fix.** Once A1 restores transactions, delete the SQL variant and evaluate these
rules in TypeScript over fetched rows. Until then, treat the TypeScript version
as normative and add differential tests that run both against a shared fixture
corpus and assert equality, converting silent drift into a failing test.

#### D3 — Fifty-six Playwright configs that differ by three lines

**Medium.**

- 56 `playwright.*.config.ts` files at the repository root.
- 50 `test:e2e:*` npm scripts.
- Diffing two sibling configs yields only port, `testMatch`, and `outputDir`.

The repository root is hard to navigate, any change to shared browser or timeout
policy means editing 56 files, and ports are hand-assigned integers.

**Fix.** One `playwright.config.ts` exporting a `defineSuite({ name, spec })`
factory that derives the port from an index, plus a suite manifest. One npm
script, `test:e2e -- <suite>`. Removes roughly 55 files with no coverage change.

### Performance

These findings are reasoned from code structure. They have not been measured
against a running deployment, and should be confirmed with profiling before
being treated as quantified.

#### P1 — Cache invalidation fired by shotgun

**High.**

- 184 `revalidatePath` calls repository-wide.
- 38 in `app/actions/sessions.ts` alone.
- `correctAcknowledgedSet` invalidates 9 routes in one call.

Correcting one set discards the cached render of history, coach, export, archive,
recovery, today, and two more. Every subsequent navigation re-renders from cold.

**Fix.** Move to tag-based invalidation with pages declaring the tags they
consume, so invalidation follows the data graph rather than a hand-maintained
route list.

#### P2 — No streaming anywhere, so every page is a blocking waterfall

**High.**

- Zero uses of `Suspense` across `src/app`.
- `app/(main)/session/[id]/page.tsx`: 8 sequential awaits.
- `app/(main)/settings/setup/[section]/page.tsx`: 8 awaits, 1 `Promise.all`.
- 13 further pages with 4 or more awaits and no parallelism.

Time to first byte is the sum of every query on the route. On the session page,
loaded at the start of a workout, that is eight round trips before any markup is
sent.

**Fix.** Two mechanical steps: `Promise.all` every independent read, then wrap
non-critical regions (media previews, coach messages, previous-set comparisons)
in `Suspense` so the workout UI streams first.

#### P3 — A new database pool is built and destroyed per progression job

**High.**

- `services/progression-jobs.ts:76` constructs `new Pool({ ..., max: 1 })`.
- `services/progression-jobs.ts:81` calls `await pool.end()` in a `finally` block.

Every job pays a full TCP and TLS handshake, then discards the connection. A
drain of up to 25 jobs performs 25 sequential connection setups.

**Fix.** Hoist the pool to a module-level singleton, mirroring the existing
`getRetryableSingleton` pattern in `src/db/index.ts`, and drop the `pool.end()`.

#### P4 — N+1 update loop when expiring stale recommendations

**Medium.**

- `services/recommendation-evidence-eligibility.ts:351` runs `for (const … of stale)` with an `await db.update()` inside.

One round trip per stale recommendation, executed serially. Small today because
the dataset is small; it grows linearly with history.

**Fix.** A single statement using `inArray(recommendations.id, staleIds)` with
`.returning()`. Identical result, one round trip.

#### P5 — Two very large client components ship to the phone mid-workout

**Medium.**

- `components/session/session-runner.tsx`: 4,584 lines; 37 `useState`, 24 `useEffect`, 21 `useRef`.
- `components/session/exercise-card.tsx`: 4,040 lines; 20 `useState`.
- 108 client components repository-wide.

Thirty-seven independent state atoms in one component means any state change
re-renders the entire active workout tree. It is also the hardest file in the
repo to modify safely.

**Fix.** Consolidate related state into `useReducer` keyed by workout concern
(timer, outbox view, drawers, selection), and extract drawer and panel subtrees
into separately memoised components.

### Scalability

#### S1 — A process-local user cache that multi-instance deployment invalidates

**High.**

- `lib/user-id-cache.ts` holds a module-level `Map`, 16 entries, no TTL.
- `logSet` compensates by calling `refreshCurrentUserIdFast` on a `not_found` outcome.

The cache is per-instance and never expires. The application is single-user by
design — the allowlist is an environment variable — so this is currently safe,
and the authors clearly knew the risk, since the hot path already retries against
a stale id. But the safety argument rests on the ownership predicate inside the
SQL, not on the cache being correct.

**Fix.** Keep the cache, add an explicit TTL, and record the single-tenant
precondition in [ARCHITECTURE.md](ARCHITECTURE.md). If multi-tenancy is ever
planned, this module and the allowlist are the two things that must change first.

#### S2 — Advisory locks scoped to statements that cannot span operations

**Medium.**

- `services/history-revision-lock.ts` uses `pg_advisory_xact_lock`, released at transaction end.
- Seven services depend on it.

`pg_advisory_xact_lock` is the right primitive, but without interactive
transactions each statement is its own transaction, so the lock is released the
instant the statement ends. Cross-statement invariants must therefore be squeezed
into one statement, which is the same pressure that produced A1.

**Fix.** Resolved by A1. Once real transactions exist, the lock spans the whole
operation as designed.

#### S3 — Heavy index load concentrated on the write-hot tables

**Medium.**

- 148 index declarations across the schema.
- 43 in `db/schema/session.ts`, covering 13 tables.

Session tables take the highest write volume in the product, and every index is
maintained on each insert.

**Fix.** Measure before cutting. Enable `pg_stat_user_indexes` and drop only
indexes with zero scans over a representative window. The additive-migration
policy means any drop needs its own reviewed migration. Do not act on this
finding without data.

### Maintainability

#### M1 — Forty-nine files over 800 lines; two functions over 800

**High.**

- 49 files exceed 800 lines; 10 exceed 1,500.
- Largest: 4,584 / 4,040 / 3,801 / 3,767 / 3,116 lines.

Review quality degrades past roughly 500 lines, and these files touch the most
consequential data in the product.

**Fix.** Split by seam rather than line count: `session-lifecycle.ts` along its
verbs (start, log, append, mutate, complete, abandon), `session-runner.tsx` along
its panels. Add an ESLint `max-lines` warning at 600 to stop new growth.

#### M2 — 634 raw SQL blocks bypass the ORM's type safety

**Medium.**

- 634 `sql` template literals repository-wide.
- Top files: `record-versions.ts` (46), `history-report.ts` (45), `session-lifecycle.ts` (37).
- `src/db/result.ts` hand-maps snake_case to camelCase using a key-ordering trick.

Drizzle is present but largely bypassed on the write path, so column renames are
caught only at runtime. `camelRow` relies on sorting keys by whether they contain
an underscore to avoid collisions — a subtle rule a future edit can break
silently.

**Fix.** Keep raw SQL where it earns its place (recursive CTEs, window
functions), but type every result set with an explicit Zod row schema parsed at
the boundary, converting silent shape drift into a located error.

#### M3 — CI builds the application seven times per run

**Medium.**

- The `core` job runs migrations, tests, typecheck, lint, and build serially, on a 45-minute budget.
- The `browser` matrix rebuilds in each of 6 groups.

The gate is well designed and genuinely protective; this is a throughput problem,
not a correctness one. But a slow gate is one people learn to route around.

**Fix.** Build once, upload `.next` as an artifact, and have the browser groups
download it. Split `core` into parallel static (lint, typecheck) and test jobs.

## Refactoring strategy

Sequenced so each phase is independently shippable and reversible. No behaviour
changes in any phase.

The ordering matters more than the contents. A1 is the keystone: attempting D2 or
S2 before transactions exist means fighting the constraint rather than removing
it. Equally, the safety net must be verified before the keystone moves.

### Phase 1 — Establish the net

No production code touched. Everything after this depends on being able to prove
behaviour is unchanged.

- Add differential tests asserting the TypeScript and SQL semantics
  implementations (D2) agree across a shared fixture corpus. This is the
  highest-value test in the plan.
- Characterisation-test the `logWorkoutSetAttempt` outcome union: every branch,
  one fixture each.
- Collapse the 56 Playwright configs (D3). Pure tooling, zero risk, and it makes
  the repository navigable immediately.

### Phase 2 — Remove the constraint (A1, S2)

Swap the driver, then decompose behind the now-passing tests.

- Move the default connection to `neon-serverless` with a pooled singleton,
  reusing the pattern already proven in `progression-jobs.ts`.
- Verify the advisory locks now span whole operations, with a concurrency test
  for the owner-mutex contention path the architecture document describes.
- Decompose `logWorkoutSetAttempt` one CTE at a time into TypeScript steps inside
  a transaction. Ship after each extraction; the characterisation tests are the
  gate.
- Then delete the SQL half of D2 and route all semantics through TypeScript.

### Phase 3 — Deduplicate (D1)

Roughly 4,400 lines removed.

- Build the generic outbox factory, migrate one queue first (start with
  `occurrence-mutation`, the smallest), verify against its existing tests, then
  migrate the rest.
- Resolve the Web Locks divergence deliberately: choose fail-closed or fail-open
  once, document the choice, and apply it everywhere.

### Phase 4 — Tighten the layers (A2, A3, A4)

- Extract one read model per route; remove database imports from pages.
- Rename `lib` / `services` to `lib` / `domain` by dependency reality, add
  `server-only` throughout, and enforce direction with ESLint.
- Converge result types on the `{ outcome }` union, module by module.

### Phase 5 — Performance (P1–P5, M3)

- Pool singleton (P3) and the batched update (P4) first — both are small.
- `Promise.all`, then `Suspense` boundaries across the page set.
- Tag-based invalidation to replace the 184 path calls.
- Split the two large client components; build once in CI.

## Suggested code

Concrete shapes for the highest-leverage changes. Behaviour is identical in every
case.

### D1 — one outbox instead of five

Currently repeated verbatim in four files:

```ts
// workout-set-outbox.ts, contextual-note-outbox.ts,
// occurrence-mutation-outbox.ts, live-coach-outbox.ts
export function nextWorkoutSetRetryDelayMs(attemptCount: number) {
  const delays = [1_000, 3_000, 10_000, 30_000, 120_000, 300_000];
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
}

function browserStorage(): WorkoutSetOutboxStorage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}
```

Proposed `lib/outbox/create-outbox.ts`:

```ts
export type OutboxConfig<TPayload> = {
  storageKey: string;
  lockName: string;
  maxEntries: number;
  maxAutoAttempts: number;
  /** Fail closed when cross-tab coordination is unavailable. */
  requireLock: boolean;
  codec: {
    parse: (raw: unknown) => TPayload | null;
    hash: (payload: TPayload) => string;
  };
};

const RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 120_000, 300_000] as const;

export function retryDelayMs(attemptCount: number): number {
  const index = Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index];
}

function browserStorage(): OutboxStorage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

export function createOutbox<TPayload>(config: OutboxConfig<TPayload>) {
  async function withLock<T>(task: () => T | Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(config.lockName, { mode: "exclusive" }, task);
    }
    // One decision, applied to every queue - no per-module divergence.
    if (config.requireLock) {
      throw new OutboxUnavailableError(config.storageKey);
    }
    return task();
  }

  return {
    withLock,
    read: (storage = browserStorage()) => readSnapshot(storage, config),
    enqueue: (entry: NewEntry<TPayload>) => withLock(() => append(entry, config)),
    markTransientFailure: (clientKey: string, reason: string) =>
      withLock(() => backOff(clientKey, reason, config)),
    retry: (clientKey: string) => withLock(() => requeue(clientKey, config)),
    // ...one implementation of quarantine, eviction, and owner-scoped clearing
  };
}
```

Each queue then becomes configuration:

```ts
// lib/workout-set-outbox.ts
export const workoutSetOutbox = createOutbox<WorkoutSetCommand>({
  storageKey: "repbook.workout-set-outbox.v1",
  lockName: "repbook.workout-set-outbox",
  maxEntries: 100,
  maxAutoAttempts: 6,
  requireLock: true,
  codec: workoutSetCommandCodec,
});
```

### A1 — restore transactions

Currently, in `services/progression-jobs.ts`:

```ts
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const transactionalDb = drizzle(pool, { schema });
  return await transactionalDb.transaction(callback);
} finally {
  await pool.end();   // full TCP + TLS handshake discarded every job
}
```

Proposed, in `src/db/index.ts`:

```ts
const globalPool = globalThis as typeof globalThis & {
  repbookPoolState?: { value?: Promise<TransactionalDb> };
};

/** Pooled WebSocket driver: supports interactive transactions. */
export function getDb(): Promise<TransactionalDb> {
  const state = (globalPool.repbookPoolState ??= {});
  return getRetryableSingleton(state, async () => {
    const url = optionalEnv("DATABASE_URL");
    if (!url) return createEmbeddedDb();          // PGlite, unchanged
    const [{ Pool }, { drizzle }] = await Promise.all([
      import("@neondatabase/serverless"),
      import("drizzle-orm/neon-serverless"),
    ]);
    return drizzle(new Pool({ connectionString: url }), { schema });
  });
}
```

The hot path can then read as prose:

```ts
export async function logWorkoutSet(
  db: TransactionalDb,
  userId: string,
  input: LogWorkoutSetInput,
): Promise<LogWorkoutSetResult> {
  return db.transaction(async (tx) => {
    await acquireHistoryRevisionLock(tx, userId);   // held for the whole operation

    const setup = await loadOwnedSessionExercise(tx, userId, input.sessionExerciseId);
    if (!setup) return { outcome: "not_found" };

    // Rules move out of jsonb_array_elements and back into testable TypeScript.
    const semantics = classifySetMetricContainment(setup, input);
    if (!semantics.ok) {
      return { outcome: "performed_evidence_conflict", reason: semantics.reason };
    }

    const equipment = evaluateEquipmentCompatibility(setup, input);
    if (!equipment.ok) return { outcome: "equipment_selection_required", ...equipment };

    const blocker = await findBlockingOccurrence(tx, setup, input.setNo);
    if (blocker) return { outcome: "set_order_blocked", blocker };

    const set = await insertCompletedSet(tx, setup, input);
    await recordOccurrence(tx, setup, set, input);
    if (input.pain) await recordPain(tx, setup, set, input.pain);
    return { outcome: "logged", set };
  });
}
```

### P4 — one round trip instead of N

Currently, in `services/recommendation-evidence-eligibility.ts`:

```ts
for (const { recommendation } of stale) {
  const expired = await db.update(recommendations)
    .set({ status: "expired", reconciledAt: new Date(), reconciliationReason: REASON })
    .where(eq(recommendations.id, recommendation.id))
    .returning({ id: recommendations.id });
  expiredCount += expired.length;
}
```

Proposed:

```ts
const staleIds = stale.map(({ recommendation }) => recommendation.id);
const expired = staleIds.length
  ? await db.update(recommendations)
      .set({ status: "expired", reconciledAt: new Date(), reconciliationReason: REASON })
      .where(inArray(recommendations.id, staleIds))
      .returning({ id: recommendations.id })
  : [];
expiredCount += expired.length;
```

### P1 — invalidate the data, not a list of routes

Currently, in `correctAcknowledgedSet`:

```ts
revalidatePath(`/session/${sessionId}`);
revalidatePath(`/history/${sessionId}`);
revalidatePath("/today");
revalidatePath("/history");
revalidatePath("/coach");
revalidatePath("/export");
revalidatePath("/archive");
revalidatePath("/recovery");
revalidatePath("/recovery/versions");
```

Proposed:

```ts
// lib/cache-tags.ts - one vocabulary, used by readers and writers alike
export const cacheTags = {
  workout: (id: string) => `workout:${id}`,
  history: (userId: string) => `history:${userId}`,
  recommendations: (userId: string) => `recommendations:${userId}`,
} as const;

// in the action
revalidateTag(cacheTags.workout(sessionId));
revalidateTag(cacheTags.history(user.id));
revalidateTag(cacheTags.recommendations(user.id));
```

## Scorecard

| Dimension | Assessment | Evidence |
| --- | --- | --- |
| Domain modelling | Strong | Intent / evidence / proposal separation held consistently |
| Data safety | Strong | 83 additive migrations, replayed in CI |
| Test coverage | Strong | 121k test lines, 273 unit and 56 browser specs |
| Offline resilience | Strong | Outbox, Web Locks, idempotency keys |
| Purity of engine layer | Strong | 9 modules, zero database or service imports |
| Layer boundaries | Weak | 30 of 38 pages query the database directly |
| Code duplication | Weak | 5 outboxes, 2 semantics engines, 56 configs |
| Function granularity | Weak | Two functions over 800 lines |
| Read performance | Weak | No `Suspense`, 184 path invalidations |
| Transaction model | Critical | Disabled app-wide by driver choice |

The single most important sequencing note: do not start by splitting the large
files. Start by restoring transactions. The large files are a symptom of the
missing transaction boundary, and splitting them first means reorganising code
that Phase 2 would delete outright.
