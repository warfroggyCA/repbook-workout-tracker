# Active Workout Phase 2 design QA

## Comparison target

- Source visual truth:
  - `docs/assets/active-workout-north-star/01-set-entry-390x844-115.jpg`
  - `docs/assets/active-workout-north-star/05-set-entry-390x844-145.jpg`
  - `docs/assets/active-workout-north-star/07-set-entry-320x700-145.jpg`
- Rendered implementation:
  - `docs/assets/active-workout-phase2-qa/01-set-entry-390x844-115.jpg`
  - `docs/assets/active-workout-phase2-qa/05-set-entry-390x844-145.jpg`
  - `docs/assets/active-workout-phase2-qa/07-set-entry-320x700-145.jpg`
- Full-view comparisons:
  - `docs/assets/active-workout-phase2-qa/01-set-entry-390x844-115-comparison.jpg`
  - `docs/assets/active-workout-phase2-qa/05-set-entry-390x844-145-comparison.jpg`
  - `docs/assets/active-workout-phase2-qa/07-set-entry-320x700-145-comparison.jpg`
- Focused comparisons:
  - `docs/assets/active-workout-phase2-qa/stacked-controls-320x700-145-comparison.jpg`
  - `docs/assets/active-workout-phase2-qa/fixed-action-320x700-145-comparison.jpg`
- State: light-theme Barbell Back Squat set entry, with set 1 saved, set 2
  current, and set 3 planned.
- CSS viewports and source/implementation pixels: 390 by 844 at 115%,
  390 by 844 at 145%, and 320 by 700 at 145%. Every source and rendered
  pair has equal pixel dimensions.
- Device scale factor: 1. No density normalization was needed.

The artboards define the Phase 2 layout direction; the written North Star
contract supersedes static shorthand. The implementation therefore keeps
**Saved** instead of **Logged**, uses visible **Review** text instead of an
unlabelled finish flag, and retains truthful supporting content that the static
mock omits. Phase 2 is limited to fixed action, focus safety, measured overlay
clearance, and large-text set-entry layout. Neutral nonblocking rest remains
Phase 3, while equipment decisions and reason persistence remain Phase 4.

## Findings

No actionable P0, P1, or P2 difference remains within the Phase 2 scope.

- The fixed area contains one blue **Log set 2** action, exact note access, and
  visible **Review** access at both named mobile widths. It does not duplicate
  the set writer or expose a second row-level Log action.
- At 145%, weight and repetitions stack, all four steppers remain visible, and
  the load-source label wraps instead of being hidden or ellipsized.
- When text size or the visual viewport changes while the current row or one of
  its fields owns focus, the focused control is re-revealed above the measured
  fixed area. The 320 by 700 capture intentionally scrolls supporting header
  content above the viewport so the current performed controls remain usable;
  this follows the written stress-case priority.
- The surrounding header, warm-up summary, supporting cues, and full exercise
  actions make the real application denser than the static artboard. That is an
  intentional phased-product difference, not a Phase 2 fidelity defect. No
  capability was deleted merely to make the screenshot shorter.

## Required fidelity surfaces

- Fonts and typography: source and implementation use Repbook's Geist stack
  and established type scale. At 145%, **Log set 2**, performed values, units,
  target, and load provenance remain readable without clipped essential text.
- Spacing and layout rhythm: the fixed three-control grid fits at 390 and 320
  CSS pixels. The implementation uses the measured overlay variable plus safe
  area and content buffer rather than a guessed fixed bottom padding. Current-
  row focus moves the taller real content into the available viewport.
- Colors and tokens: primary action, selected row, acknowledgement success,
  borders, and backgrounds use existing repository tokens. Amber is not added
  to ordinary set entry, rest, selection, or replacement states in this phase.
- Image quality and asset fidelity: the compared state has no photographic or
  illustrative assets. Existing component and Lucide icons remain vector-
  rendered; Phase 2 adds no placeholder, emoji, CSS-drawn, or custom SVG art.
- Copy and content: **Log set 2**, **Review and finish workout**, **Add training
  note**, **Performed measure**, **Load: earlier workout set**, **Saved**, and
  **Planned** retain exact state meaning. The compact visible **Review** label
  keeps the full consequential accessible name.
- Icons and affordances: the note icon keeps its exact accessible name and a
  minimum 44-pixel target. Decrement and increment controls remain labelled,
  visible, and at least 44 by 44 CSS pixels at 145%.
- Responsiveness and accessibility: browser assertions prove no horizontal
  page overflow, four visible and unobscured steppers, and fixed controls at
  390 by 844 and 320 by 700 with 145% text. Focus lands on a stable rest or
  current-row region rather than a stepper. During a held no-rest save, the
  fixed action is rebound to the next exact form, focus moves to that row, and
  a repeated Enter does not submit its prefilled values. A failed retained save
  instead moves focus to the recovery alert.
- Interaction and console evidence: the production-build browser harness
  exercised logging through the form-associated fixed action, rest transition,
  rest dismissal, focus handoff, text-size change, viewport resize, equipment
  baseline, destructive-review entry, and workout discard. Its page-error
  observer reported no unexpected browser error.

## Comparison history

1. Pass 1 found two P2 responsive defects. **Log set 2** wrapped at 390 by 844
   with 145% text, and resizing an already-focused workout could leave the
   stacked controls below the fixed overlay. The compact finish label now reads
   **Review** at mobile widths, and focused current content is re-revealed after
   text-size, window, or visual-viewport changes.
2. Pass 2 confirmed that the controls and fixed action were clear, then found
   one P2 truth/legibility defect: **Load: earlier workout set** was ellipsized
   at 145%. The heading and provenance now stack and wrap at the narrow extra-
   large breakpoint.
3. Pass 3 recaptured every named viewport and rebuilt the combined full-view
   and focused comparisons listed above. It found no remaining actionable
   P0/P1/P2 difference within Phase 2. Automated geometry, accessible-name,
   overflow, focus, and stray-Enter assertions passed against the same build.
4. Fresh-context review found one P1 keyboard seam outside the static captures:
   a no-rest transition could rebind the still-focused fixed Log control while
   the preceding write awaited acknowledgement. The fixed submit now remounts
   for each exact form, the new row receives focus without consuming the
   acknowledgement-owned handoff, and failed saves focus their recovery alert.
   Focused production-build checks cover both the held acknowledgement and
   retained failure paths.
5. Final fresh-context review confirmed the keyboard and recovery fixes, then
   found one P2 duplicate action when an appended extra set became current.
   Fixed-action ownership now follows the exact current editable row instead of
   excluding every appended row: a current extra set uses the fixed Log action,
   while a non-current extra set retains its inline fallback. Focused component
   and T05 journey assertions cover both states.

## Open questions

None for Phase 2. Rest presentation and equipment decision semantics retain
their explicit later-phase gates.

## Implementation checklist

- [x] Keep one truthful fixed primary action without duplicating persistence.
- [x] Move post-log and post-rest focus to stable, inert targets.
- [x] Keep weight and repetition steppers visible at 145% by stacking measures.
- [x] Preserve load provenance without truncation at narrow extra-large text.
- [x] Preserve measured overlay, safe-area, visual-viewport, and keyboard
  clearance.
- [x] Verify fixed-action names, visible Finish review copy, and touch targets.
- [x] Verify the named viewports with combined source/implementation evidence.

## Follow-up polish

No Phase 2-only P3 refinement is required before review. Do not partially
implement the Phase 3 rest strip or Phase 4 equipment decision in this branch.

final result: passed
