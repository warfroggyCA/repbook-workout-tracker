# Workout flow screens

The training screens use the existing session, equipment, history and recommendation systems. The changes described here are presentation changes; they introduce no second workout sequence, load conversion or automatic Program mutation.

## Today and current-set logging

Today uses a concise functional heading, the current coaching decision, quick text/device-dictation entry and a prominent start or resume action. Existing readiness, schedule, equipment, time-adjustment review, warnings and alternate-day decisions remain authoritative.

Current set view and Full workout view share the same occurrence ledger. Pending or failed saves, equipment decisions and recovery targets stay visible. Earlier exercises also remain visible when the ledger reports completed-without-result or unknown evidence, or unlinked, duplicate or contradictory records. A collapsed card keeps a review warning visible; opening it reveals the existing exact ledger. Normal disclosure behavior and current-action selection are preserved. A disclosure holds acknowledged history and future sets while preserving saved-set correction. Warm-ups, supersets, rest deadlines, quick notes and undo continue through their existing commands.

Large weight and reps fields have explicit top padding and a workout-scoped height variable. Other compact editors keep their prior fallback size. The numeric type and control arrangement are preserved; motivational headlines are omitted to give space to workout content.

## Workout-only swaps

The existing alternative and replacement flows supply candidate availability, constraints and allowed selections. The swap review explains equipment fit, load convention, separate exercise histories and workout-only scope before the existing confirmation command runs. Duplicate catalogue prose and a duplicate Back control are omitted in this context; the full library detail remains available elsewhere.

Known per-implement amounts are named as such. Existing totals remain totals. Unknown conventions remain explicit; an implement count or combined load is never inferred from an exercise name. Reps-only replacements do not ask for a fabricated numeric weight.

The picker explains how starting evidence is selected. Exact comparable sets and the starting entry continue to appear in the existing editor after a swap; the picker does not invent a numeric preview. Completed sets retain their original exercise. Existing idempotency, stale-state reconciliation, warnings, failure/retry and undo behavior remain authoritative.

## Next-session review

A supported load proposal presents its proposed target beside its reason, with its current target and saved future effect kept distinct. Missing current targets or units stay explicit. Editing a proposal updates the explanation of what approval will use. The original proposal remains inspectable.

Only the existing explicit approval command applies a change, subject to its owner, evidence and revision checks. Unsupported or stale proposals remain blocked; automatic holds remain informational. External advice retains its separate future-Review decision semantics. Defer, resume, rejection and timeout recovery continue through the existing actions. Load editing is disabled while a decision is pending.

Review actions follow the content on narrow and enlarged-text screens so they do not cover the explanation. Existing workout summaries link to Coach for review; no new workout-completion or proposal-production path is introduced.

## Source map

- Today: src/app/(main)/today/page.tsx; src/components/dashboard/today-quick-log.tsx.
- Current set and recovery visibility: src/components/session/session-runner.tsx; src/lib/focused-workout.ts.
- Set editor: src/components/session/exercise-card.tsx; src/components/session/active-set-ledger.tsx.
- Swap review: src/components/exercises/exercise-picker.tsx; src/components/exercises/workout-swap-summary.tsx.
- Decision review: src/components/coach/recommendation-card.tsx; src/app/(main)/coach/page.tsx.
- Existing independent progression and comparable-history rules: src/engine/progression/rules.ts; src/services/progression.ts; src/services/previous-comparable-sets.ts; src/lib/set-metric-semantics.ts.

## Verification and limits

Use the component tests for focused-workout, active-set-ledger, exercise-card, workout-swap-summary and recommendation-card, together with the existing replacement, comparable-history and review-decision tests. The workout-feedback browser journey checks numeric field padding, text fit, narrow widths and enlarged text, as well as logging, correction, warm-ups, rest reload and offline/reconnect. The replacement-mobile and v2-h05 journeys cover swap recovery and evidence-linked review.

Browser emulation does not certify physical lock/close recovery or background alarm delivery. Those behaviors require actual-device testing. No claim is made that the entire import/restore test matrix or complete repository suite has been rerun for a presentation change.
