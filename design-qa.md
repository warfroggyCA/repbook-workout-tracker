# Active Workout Phase 1 design QA

## Comparison target

- Source visual truth: `docs/assets/active-workout-north-star/01-set-entry-390x844-115.jpg`
- Rendered implementation: `docs/assets/active-workout-phase1-qa/set-entry-390x844-115.jpg`
- Full-view comparison: `docs/assets/active-workout-phase1-qa/set-entry-390x844-115-comparison.jpg`
- Focused ledger comparison: `docs/assets/active-workout-phase1-qa/set-entry-focus-comparison.jpg`
- State: light-theme set entry for Barbell Back Squat, with set 1 saved, set 2 current, and set 3 planned
- CSS viewport: 390 × 844 at Repbook's default 115% text setting
- Source pixels: 390 × 844
- Implementation pixels: 390 × 844
- Device scale factor: 1 for both captures; no density normalization was needed

The active-set content and viewport match. The surrounding screen is not an
identical implementation target for this phase: the checked-in artboard shows
the complete North Star, while Phase 1 changes only the set ledger. The current
header, warm-up summary, fixed-action behavior, and rest behavior therefore
remain visible in the rendered application and are assessed as explicit later-
phase boundaries rather than silently treated as matches.

## Findings

No actionable P0, P1, or P2 difference remains within the Phase 1 compact-set-
ledger scope.

- The full-view comparison preserves the intended information order inside the
  expanded exercise: saved result, current target and performed entry, then the
  future target. The outer page remains taller than the complete North Star
  because its header and warm-up compaction are not part of Phase 1.
- The focused comparison confirms that prescribed values, performed inputs,
  acknowledgement state, prior-comparison context, and next-action context are
  visually distinct. Repbook deliberately says **Saved**, not the mock's
  **Logged**, because the written North Star contract reserves that status for
  server acknowledgement.
- Phase 2 still owns the fixed primary action, safe post-log focus handoff, and
  stacked stepper controls at 145% text. Phase 3 still owns neutral,
  nonblocking rest. These visible whole-screen differences remain explicit in
  `docs/ACTIVE_WORKOUT_NORTH_STAR.md` and were not partially reimplemented here.

## Required fidelity surfaces

- Fonts and typography: both use the repository's Geist stack and established
  weights. The current-row label, target, performed values, and small status
  text remain scannable without truncating the recorded result at 390 pixels.
- Spacing and layout rhythm: compact saved and planned rows frame one expanded
  current row. Fixed 44-pixel default-size steppers keep the performed values
  visible. Card radius, borders, and row dividers use the existing component
  system rather than one-off approximations.
- Colors and tokens: the current row uses `--surface-selected`, saved state uses
  the established success color, and attention color is reserved for retained,
  failed, or otherwise decision-requiring states. Color is not the only status
  signal.
- Image quality and asset fidelity: this screen contains no photographic or
  illustrative assets. Existing Lucide/component icons remain vector-rendered;
  no placeholder, CSS-drawn, emoji, or custom inline-SVG substitute was added.
- Copy and content: **Target**, **Performed measure**, **Saved**, **Planned**,
  **Unsaved on this device**, and **Needs attention** keep intended facts and
  delivery state separate. Unknown evidence is labelled unknown rather than
  inferred.
- Icons and affordances: the existing exercise, disclosure, decrement,
  increment, acknowledgement, and action icons retain their established style,
  accessible names, and touch targets.
- Responsiveness and accessibility: the active-workout hierarchy suite passed
  at 390 × 844 across compact, default, large, and extra-large text, at 320 ×
  700 extra-large text, and at 440 × 956 default text in Chromium and WebKit.
  Keyboard, reduced-motion, no-horizontal-overflow, recovery, and mobile input
  paths passed. The expected failing post-log Enter regression remains the
  explicit Phase 2 gate rather than being hidden.
- Interaction and console evidence: the production-build browser harness
  exercised normal logging, saved acknowledgement, retained/retry recovery,
  correction, added sets, skips, assisted and timed measures, plate and machine
  semantics, replacement, superset order, and import-to-workout flow. Its
  page-error observer reported no unexpected browser errors.

## Comparison history

1. Pass 1 found a P2 default-size legibility defect: rem-scaled stepper width
   and padding obscured performed values at 390 × 844. The row was changed to
   fixed 44-pixel controls with the value and unit stacked centrally. A new
   production-build capture showed both values without clipping.
2. Pass 2 found a P2 density defect: repeated metadata, generous row padding,
   and verbose plate/previous/future context made the ledger materially taller
   than the reference hierarchy. Row spacing and secondary copy were compacted
   while retaining those semantics and actions. The next capture restored a
   clear saved/current/planned scan.
3. Pass 3 used the checked-in full-view and focused comparisons above. It found
   no remaining actionable P0/P1/P2 issue inside Phase 1. The 145% and 320 × 700
   captures were also inspected, while their deliberate stepper and fixed-bar
   differences remain assigned to Phase 2.

## Implementation checklist

- [x] Render every projected lifecycle state without inventing a second data source.
- [x] Keep the existing performed-value controls and save handler in the current row.
- [x] Preserve optional details, skip, add-set, recovery, correction, and exact load semantics.
- [x] Verify default and enlarged mobile layouts, keyboard paths, and reduced motion.
- [x] Preserve Phase 2 and Phase 3 boundaries without partial focus or rest changes.

## Follow-up polish

No Phase 1-only P3 refinement is required before review. Continue with the
approved Phase 2 and Phase 3 work only after their separate owner gates.

final result: passed
