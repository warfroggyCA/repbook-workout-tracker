# Program editor and timed-prescription implementation plan

Status: implemented. The verification contract below grants no release or production-data authority.

## Outcomes and boundaries

1. Allow natural editing of all five day-level minute fields. Preserve incomplete
   values in local recovery, invalidate earlier review, and let the existing
   server schema reject invalid bounds. Never adjust another field implicitly.
2. Preview an exact drag destination and apply one reorder on pointer release.
   Cancellation changes nothing. Preserve exact slot identities, group membership,
   rounds/rest, and warm-up anchors; retain keyboard and button alternatives.
3. Add an explicit one-time **Use for all days** action for transferable day
   intent. Keep destination exercise anchors and all exercises, groups, and
   warm-ups. All affected days remain visible in the normal draft review.
4. Support explicit timed exercise prescriptions, including loaded time per side.
   Duration and repetition measurements must remain different stored facts.
   Existing rep prescriptions require an explicit owner edit; no name matching,
   catalog rewrite, historical conversion, or automatic Program publication.

## Implemented timed measurement contract

The original Program and prescription table required repetitions, and the duration
writer rejected measured load. Migration 0087 adds an optional versioned
`timedPrescription` with metric `weight_duration_per_side`, integer `minSeconds`
and `maxSeconds` (1–3600), null repetition bounds, and manual progression.
The owner selects **Kettlebell Suitcase Carry** when using a kettlebell, then
**Loaded time — each side** in the Program editor and reviews publication
normally. The new catalog variant is additive and does not share the existing
dumbbell carry identity. Existing notes are retained and should be reviewed for
contradictory rep-as-seconds instructions.

Normal and compiled Start freeze the prescription and measured load meaning.
One performed set records its load/unit and the seconds completed on each side;
both sides are completed before the existing rest transition. No duration is
invented from the target. Saving/retry, set correction, record-version restore,
History, CSV, canonical JSON and encrypted snapshots preserve the metric.
CSV includes `timed_prescription_json`. Coach context receives the typed target
and raw measurement; repetition progression and calculated target outcomes are
unavailable for this metric.

Snapshot schema 38 retains the new fields. Older envelopes cannot contain this
new meaning, including in drafts, compiler evidence or record versions. Upgrades
add nulls without interpreting historical reps as seconds. Recovery manifest 16
is unchanged because the table inventory is unchanged. After new timed writes,
do not roll back to an application that requires repetition targets or cannot
understand schema 38. Deploy the matching application and migration through the
separate owner gates.

The retrospective workout form cannot author this measurement yet and refuses
a linked timed Program day rather than dropping its time prescription. Existing
retrospective and external import measurements keep their contracts. This change
does not convert existing catalog metrics or add a timer, distance tracking, independent
left/right durations, or automatic load recommendations.

Use additive schema changes only where existing contracts cannot represent
these facts. Preserve old records and old snapshot meaning. Repetition progression
must never run on seconds; any future load suggestion needs a compatible timed
contract or an explicit unavailable state. No timer or distance feature is in scope.

## Verification and delivery

Use synthetic fixtures only. Test incomplete/invalid edits and local recovery;
non-contiguous groups, exact drop boundaries, cancellation, keyboard/buttons,
warm-up identity and reload; day-option copy and independent later edits;
and timed prescription/write/read/recovery plus legacy preservation.

Run focused unit and database checks, typecheck, lint, build, documentation checks,
and actual desktop and narrow-screen browser journeys. Persistence extensions
also require migration replay, upgrade, PostgreSQL integration, affected snapshot
and recovery suites. Record unverified physical-device behavior separately.

Prepare one reviewable application PR. Merge, hosted Preview, production release,
production migration, live draft conversion/publication, and private release-record
merge remain separate owner gates.
