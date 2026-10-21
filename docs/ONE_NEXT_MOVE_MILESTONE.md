# One next move — first implementation milestone

Baseline: public RepBook v2.3.2, commit 7d577b421a376423080690e9418f0b76fbf0a39f. Isolated branch: codex/one-next-move. The separate private operational checkout and its uncommitted work are untouched.

## What is implemented

Today uses the accepted off-white and dark-green coaching direction, oversized arrival headline, a prominent bottom start/resume action on phones, and a quick-log drawer. Existing readiness, schedule, equipment, shortened-workout review, warnings and alternate-day decisions remain authoritative.

An active workout starts in Current set view, with a Full workout option. The existing set editor, saved-set correction, warm-ups, superset ordering, equipment choices and rest clock remain in use. A disclosure holds acknowledged history and future sets; pending saves, failures and uncertain records remain visible. A contextual voice/text note entry remains available. The larger dark workout presentation uses lime primary controls.

Handheld load labels follow the recorded convention. Proven per-implement weights are explicitly named. Existing totals stay totals; ambiguous records are not converted and no pair count is guessed. This is wording only, with no migration or calculation change.

## Comparison with openGym

The useful lesson is clarity: one next action, explicit load meaning, understandable next targets and a modular distinction between training records and proposed changes. RepBook already has strong independent machinery for these needs. It should retain its progression engine, owned-equipment steps, session-only substitutions, comparable-history checks, session compiler, offline outboxes and explicit review gates. Replacing them with another application’s engine would lose safeguards and create unnecessary history risk.

Reference reviewed: openGym e348fc17c42c7e9a211c5972e573ad3698190ee2, particularly frontend/src/lib/progression.js, dumbbells.js and workout-model.js. No openGym source or exercise media is copied. The developer’s permission scope has not been independently verified; this implementation uses RepBook’s own code.

## Strengths that must survive

- Exact historical exercise, unit and load meaning; unknown values stay unknown.
- Review before routine or progression changes; session-only swaps preserve independent exercise histories.
- Visible save state, offline retention, correction, undo and recovery.
- Warm-ups, supersets, rest deadlines, equipment-specific plate math and safety context.
- Quick text logging and supported device dictation alongside the full workout overview.

## Source map

- Today and quick entry: src/app/(main)/today/page.tsx; src/components/dashboard/today-quick-log.tsx; src/components/quick-log/quick-log-card.tsx.
- Focus selection: src/components/session/session-runner.tsx; src/lib/focused-workout.ts.
- Set history and current editor: src/components/session/active-set-ledger.tsx; src/components/session/exercise-card.tsx.
- Independent progression guards: src/engine/progression/rules.ts; src/services/progression.ts.
- Historical comparability: src/lib/set-metric-semantics.ts; src/services/previous-comparable-sets.ts; src/lib/set-starting-load.ts.
- Existing time adjustment and rest recovery: src/services/session-compiler.ts; src/lib/rest-timer.ts.
- Visual treatment: src/app/globals.css; src/components/nav/main-shell.tsx.

## Remaining milestones and risks

1. Finish phone and enlarged-text review of the implemented Today/logging flow. Prove keyboard, bottom controls, recovery visibility, logging/correction, warm-ups and superset transitions in disposable data before merging. Focus hides presentation only; recovery selection must never target an invisible editor.
2. Redesign the existing session-only swap sheet around available equipment and the replacement’s own history. Preserve substitution/undo commands. Do not infer combined dumbbell loads from names or unilateral labels.
3. Redesign the existing next-session decision review with evidence, proposed target, equipment step and an explicit apply action. Keep the deterministic engine and its pain/effort/exposure guards.
4. Make the existing shortened-session review easier to reach from Today; preserve review before accepting omissions. This milestone does not add a new automatic planner.
5. Verify exact rest/session recovery after reload, offline/reconnect and a real locked phone. Web background alarms remain platform-dependent; no guarantee is made here.
6. Improve progress comparisons only where exercise identity and load meaning are comparable; retain explanations for excluded records.

## Validation status

- Normal production build passed (Next 16.3.3 Turbopack), including TypeScript and all route generation.
- Full npm run typecheck passed.
- npm run lint passed with one existing warning in src/components/simulation/simulation-runner.tsx:142. No lint errors.
- npm run docs:check passed.
- 118 selected unit tests passed across focused-workout, active-set-ledger-component, exercise-card-component, rest-timer, set-metric-semantics and progression.
- Chromium and iPhone/WebKit disposable workout browser tests passed. They cover quick entry, focused/full views, logging/correction, plate controls, warm-ups, rest reload, 320-pixel layout with 20px root text, and offline/reconnect.
- The existing Chromium superset browser test passed, covering immutable order, truthful progress and next-member equipment preparation.
- Screenshots were visually reviewed. A truncated starting-load explanation at narrow enlarged-text sizes was fixed. A clean normal build and both browser tests then passed, with explicit no-clipping assertions.

The checkout encountered blocking local file reads and inconsistent dependency module reads. Validation succeeded in /tmp/repbook-one-next-move-review with byte-copied source and a physical copy of the already-installed matching dependencies. No new software was installed. The 13 changed app/test files match byte for byte; hashes are in the accompanying verified-source.json. An earlier linked-dependency webpack attempt failed before the normal build passed and is not counted as validation. Only the disposable review copy’s generated .next cache was cleared after confirming it had served stale CSS; original repositories and their caches were preserved.

This is browser emulation, not a physical locked-phone test. Lock/close recovery, background alarm delivery, a full import/restore gauntlet and the complete repository test suite are not newly certified here. Existing engines and protection writers are unchanged. No production workout data, permissions, migration or deployment has been changed.
