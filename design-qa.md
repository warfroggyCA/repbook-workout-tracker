# Active Workout Phase 3 design QA

## Comparison target

- Source visual truth:
  - `docs/assets/active-workout-north-star/01-set-entry-390x844-115.jpg`
  - `docs/assets/active-workout-north-star/02-rest-running-390x844-115.jpg`
  - `docs/assets/active-workout-north-star/03-rest-complete-390x844-115.jpg`
  - `docs/assets/active-workout-north-star/05-set-entry-390x844-145.jpg`
  - `docs/assets/active-workout-north-star/06-rest-running-390x844-145.jpg`
  - `docs/assets/active-workout-north-star/07-set-entry-320x700-145.jpg`
- Rendered implementation:
  - `docs/assets/active-workout-phase3-qa/01-set-entry-390x844-115.jpg`
  - `docs/assets/active-workout-phase3-qa/02-rest-running-390x844-115.jpg`
  - `docs/assets/active-workout-phase3-qa/03-rest-complete-390x844-115.jpg`
  - `docs/assets/active-workout-phase3-qa/05-set-entry-390x844-145.jpg`
  - `docs/assets/active-workout-phase3-qa/06-rest-running-390x844-145.jpg`
  - `docs/assets/active-workout-phase3-qa/07-set-entry-320x700-145.jpg`
- Side-by-side comparisons, source on the left and implementation on the
  right:
  - `docs/assets/active-workout-phase3-qa/01-set-entry-390x844-115-comparison.jpg`
  - `docs/assets/active-workout-phase3-qa/02-rest-running-390x844-115-comparison.jpg`
  - `docs/assets/active-workout-phase3-qa/03-rest-complete-390x844-115-comparison.jpg`
  - `docs/assets/active-workout-phase3-qa/05-set-entry-390x844-145-comparison.jpg`
  - `docs/assets/active-workout-phase3-qa/06-rest-running-390x844-145-comparison.jpg`
  - `docs/assets/active-workout-phase3-qa/07-set-entry-320x700-145-comparison.jpg`
- Additional rendered evidence:
  - `docs/assets/active-workout-phase3-qa/10-keyboard-390x844-115.jpg`
  - `docs/assets/active-workout-phase3-qa/04-equipment-conflict-390x844-115.jpg`

The named CSS viewports are 390 by 844 at 115%, 390 by 844 at 145%, and
320 by 700 at 145%. Source and implementation images have equal dimensions;
each 390 comparison is 780 by 844 and the 320 comparison is 640 by 700. The
device scale factor is 1, so no density normalization was needed.

The checked-in artboards define direction while the written North Star
contract owns exact behaviour and copy. The real application therefore keeps
**Saved**, visible **Review**, exact cue state, exact next-set destination,
warm-up context, and existing exercise actions that the static mock abbreviates.
Phase 3 changes rest presentation and safe set access only. The equipment
capture proves that state was not visually regressed; equipment decisions and
reason persistence remain Phase 4 and were not judged as Phase 3 fidelity.

## Findings

No actionable P0, P1, or P2 difference remains within the Phase 3 scope.

- A running rest is a compact neutral strip above the existing fixed action.
  It states the countdown, cue channel, and exact destination without using
  amber or implying an athlete adherence problem.
- The destination set remains the current ledger row during rest. Its weight
  and repetition controls stay editable, and **Log set 2** stays available when
  the existing queue and form safety rules permit it. No second writer or rest-
  specific save path was introduced.
- **−15s**, **+15s**, and **End rest** remain visible, labelled, and at least
  44 by 44 CSS pixels at 115% and 145%. **End rest** records the existing
  athlete-ended rest outcome; it does not claim that planned exercise work was
  skipped.
- Elapsed rest uses one compact green **Rest complete** status for four seconds
  from the durable `readyAt` deadline and then collapses without a dismiss
  control. Athlete-ended rest uses a neutral **Rest ended** confirmation and is
  not announced as completion.
- At 145%, the truthful cue and destination text require more height than the
  abbreviated artboard. The existing measured-overlay and focus-preservation
  path re-reveals the editable destination row above that height. The result
  retains information and controls rather than matching the reference by
  hiding them.
- The surrounding header, warm-up summary, cues, and exercise actions keep the
  real product denser than the static artboards. That is an intentional phased
  difference, not a rest defect; no existing capability was removed for a
  shorter screenshot.

## Required fidelity surfaces

- Fonts and typography: the source and implementation use Repbook's Geist
  stack and existing type scale. Countdown digits are tabular; destination and
  cue text wrap instead of clipping at extra-large text.
- Spacing and layout rhythm: rest is composed above the fixed action inside the
  existing measured overlay. The 115% strip stays compact; the 145% strip grows
  only enough to preserve exact context and 44-pixel controls.
- Colors and tokens: running and athlete-ended rest use neutral repository
  tokens. Green is limited to the brief elapsed confirmation. Amber remains an
  attention colour and does not mean ordinary rest.
- Image and icon quality: this state needs no photographic or illustrative
  asset. The completion check uses the existing Lucide library; no placeholder,
  emoji, CSS-drawn, or custom SVG art was added.
- Copy and content: **Rest**, **Rest complete**, **Rest ended**, **End rest**,
  **Sound blocked** or the selected cue mode, the exact `Next:` destination,
  and **Log set 2** retain distinct meanings. A blocked or unavailable cue is
  described as a technical channel state, not a failed rest or athlete action.
- Responsiveness: browser geometry assertions cover 390 by 844 at 115% and
  145%, with the 320 by 700 set-entry stress case retained. The page has no
  horizontal overflow, the strip controls fit, and the destination row remains
  visible above the fixed area after a text-size or viewport change.
- Accessibility: the three rest controls have exact accessible names and
  minimum 44-pixel targets. Elapsed completion owns one `role="status"`, polite,
  atomic live region; running and athlete-ended states do not create a false
  completion announcement. The fixed set and Review controls remain keyboard
  reachable and at least 44 pixels in the compact durability scenario.
- Interaction and durability: the production-build browser paths exercised set
  logging, a running rest with enabled destination inputs and the exact fixed
  Log action, time adjustment, reload while running, elapsed completion, four-
  second collapse, and replay-safe reload after continuation. The existing
  absolute deadline, cross-tab store, occurrence destination, cue outcome,
  ordering, and writer remain authoritative.

## Comparison history

1. Pass 1 found one P1 semantic-colour mismatch: the elapsed state tinted the
   entire fixed action row green. Success colour is now confined to the brief
   confirmation strip, so **Log set 2** remains the ordinary primary action.
2. Pass 1 also found one P2 hierarchy mismatch: running rest had no distinct
   neutral surface. The strip now uses the existing muted surface and border,
   while preserving the app's real cue and destination text.
3. Pass 2 at 145% found one P1 usability mismatch: the taller truthful strip
   could leave the next set's inputs below the measured overlay after a text-
   size change. The existing focus-preservation effect now covers active rest
   and re-reveals that row without moving focus to a stepper.
4. Pass 3 rebuilt and inspected every combined comparison above. Set entry,
   running rest, and elapsed rest matched the written hierarchy at both named
   text sizes with no remaining actionable P0/P1/P2 difference.
5. The focused durability run exposed a test-only race between rapid repeated
   timer adjustments and asynchronous durable deadline updates. The scenario
   now waits for each deadline change and passed without changing product
   timing or adding broader test scope.
6. The protected browser matrix exposed one P1 edge outside the seven reference
   captures: completing an out-of-order workout-only exercise could leave
   earlier planned work while the rest strip said **No further work** and the
   fixed area repeated **Rest complete**. The strip now distinguishes
   **Resume plan: [exact action]** from a forward rest destination, and the
   existing fixed Log action resumes that pending set. No timer, occurrence, or
   persistence contract changed.

## Open questions

None for Phase 3. The Phase 4 equipment meaning, persistence, and migration
gate remains separate.

## Implementation checklist

- [x] Render running rest as neutral context above the fixed action.
- [x] Keep the exact destination set editable and safely loggable.
- [x] Use explicit **End rest** without implying skipped exercise work.
- [x] Show elapsed completion for four seconds with one polite announcement.
- [x] Keep cue-channel failure distinct from timer and athlete outcomes.
- [x] Preserve durable deadline, destination, ordering, cross-tab, and replay
  contracts.
- [x] Verify 115% and 145% source/implementation comparisons and touch targets.
- [x] Verify running reload, completion collapse, and continuation durability.

## Follow-up polish

No Phase 3-only P3 refinement is required before review. Do not partially
implement the high-risk Phase 4 equipment decision or reason persistence in
this branch.

final result: passed
