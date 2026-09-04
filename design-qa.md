# Active Workout design QA record

> **Historical evidence notice:** This file preserves the Phase 3 and Phase 4
> acceptance record as it was captured. For the running-rest visual treatment
> only, the muted-strip screenshots and findings below are superseded by the
> current Rest strip contract in `docs/ACTIVE_WORKOUT_NORTH_STAR.md` and the
> implementation in `src/components/session/rest-cockpit.tsx`: a cool-toned
> selected surface, stronger boundary, subtle shadow, timer icon, and larger
> countdown. The old captures remain here as rollout history, not as the
> current visual acceptance reference. Their behaviour, durability, and
> accessibility findings remain applicable.

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

No open visual question remains for Phases 3 or 4. Migration 0085 has been
verified only with disposable data; applying it to shared preview or production
remains a separate owner gate outside this design review.

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

No Phase 3-only P3 refinement is required before review.

## Phase 4 equipment-decision comparison

- Source visual direction:
  `docs/assets/active-workout-north-star/04-equipment-conflict-390x844-115.jpg`
- Rendered implementation:
  `docs/assets/active-workout-phase4-qa/04-equipment-conflict-390x844-115.jpg`
- Viewport: 390 by 844 at 115%, using the existing Geist stack, tokens,
  radii, touch target, and reduced-motion browser contract.

The source and implementation were inspected together at equal dimensions.
The written North Star supersedes the mockup's earlier **Log it anyway** copy:
a known unavailable or incompatible setup cannot be recorded as unknown. The
real product therefore presents one amber decision surface with **Replace for
today** and **Skip exercise**, keeps the Program-unchanged explanation, and
makes **Replace for today** the fixed action.

The first comparison exposed one P1 trust defect: although the fixed action was
correct, the expanded current-set row still showed an apparently available
blue **Log set** button. The final implementation removes that competing action
and explains that the setup must be resolved before logging. The rerun has no
set-log bypass, horizontal overflow, clipped action copy, or sub-44-pixel
decision target. The production-build interaction opens both forced-reason
drawers and verifies that the cause is described as equipment unavailable or
incompatible; focused database tests separately prove that it is retained.

The implementation includes more real workout context than the static artboard
and uses Barbell Back Squat rather than the artboard's sample exercise. Those
are evidence differences, not visual divergence: the decision hierarchy,
attention colour, action language, and fixed-action ownership match the
approved direction without deleting current workout information.

final result: passed

## Phase 6 integration Gauntlet

### Comparison target and evidence

- Source visual truth: the seven images in
  `docs/assets/active-workout-north-star/`.
- Rendered implementation: the complete 16-state capture in
  `docs/assets/active-workout-phase6-qa/`.
- Equal-size comparisons: files `01` through `07` with the
  `-comparison.jpg` suffix in the Phase 6 evidence directory, source on the
  left and running product on the right.
- Named viewports: 390 by 844 at 115% and 145%, plus 320 by 700 at 145%; the
  remaining state matrix also includes 844 by 390 dark landscape.
- Runtime: production build, Chromium, America/Toronto, reduced motion, device
  scale factor 1, and disposable synthetic data only.

The artboards own visual direction and the written North Star owns behaviour,
truthful copy, and recovery. The running product intentionally retains exact
warm-up, exercise, cue, ledger, Review, and recovery context that the static
artboards abbreviate.

### Findings and corrections

Fresh-context critic loops identified the following gaps in the first Phase 6
candidate. They are corrected in the current candidate. Final visual, contract,
and release-evidence reviews found no actionable P0, P1, or P2 gap in the
frozen local tree.

1. The first visual pass found one P1 hierarchy failure: automatic reveal could
   put the exact current-exercise heading above the usable viewport, especially
   at 320 by 700 with 145% text. An initial sticky-heading correction exposed a
   second P1: it masked the saved Set 1 row. The sticky treatment is removed.
   Context-aware reveal now keeps the exercise heading, saved ledger evidence,
   and current controls together, and browser assertions measure all of them in
   set, running-rest, and completed-rest states.
2. The first contract pass found one P1 truth failure: an exact saved machine
   whose required geometry was incomplete fell through to generic
   incompatibility. The shared resolver now projects
   `configuration_incomplete`; the decision surface names the missing fields
   and offers **Complete equipment setup**, without Replace, Skip, or Log.
3. Follow-up contract review found that both the generic exercise Skip drawer
   and the separate offline-capable set-occurrence path could outlive their
   equipment evidence. Both controls now expose the equipment cause only for a
   canonically verified conflict. Both server writers independently revalidate
   and equipment-source-fence the cause. An action-level regression queues a
   valid unavailable-equipment skip, transitions the setup to
   `configuration_incomplete`, and proves replay changes neither the occurrence
   nor its mutation receipts; the outbox retains the rejected command for
   explicit review.
4. The visual follow-up also found that narrow portrait reduced the consequential
   action to ambiguous **Review**. It now retains the full **Review and finish**
   wording on two lines when needed.
5. The final production-build browser pass regenerated all 16 state captures and
   passed eight scenarios across the common, equipment-choice, known-conflict,
   and configuration-incomplete fixtures. The dedicated incomplete-state path
   verifies its exact heading and missing fields, blocked Log, truthful action,
   dock focus, and Settings navigation. The complete 16-file focused contract
   command passed all 260 tests and is recorded in `docs/DEVELOPMENT.md`; it
   includes the exercise writer, occurrence writer, outbox, Finish label, and
   protected-command contracts.
6. The seven equal-size comparisons are generated by
   `npm run active-workout:phase6-comparisons`, and the evidence contract now
   rejects missing or empty comparison files.
7. A final contract pass found that retained broad identity was filtering only
   completed options, after incomplete geometry had already been classified.
   The same retained fence now filters every primary candidate before exact
   resolution. A wrong-definition or under-capacity partial machine therefore
   remains incompatible and is never named as a setup the owner should finish.
8. The same pass found two automatic-selection paths. The server now verifies
   `auto_unique` against the current canonical option list, including retained
   identity and optional attachments. Database regressions prove one eligible
   plus one wrong-definition profile still auto-selects correctly, while a
   newly added optional cable attachment makes a queued automatic choice
   ambiguous with no snapshot or receipt. A deterministic post-preflight race
   likewise proves stale equipment evidence cannot write an occurrence skip.
9. Pull-request review found the corresponding bulk Finish path still allowed
   an equipment cause for incomplete setup. Finish now requires verified
   conflicts for every pending item, with a server source and membership check.
   Other explicit causes remain available; retained terminal commands preserve
   their exact replay identity. Focused database, action, browser, and native
   PostgreSQL race regressions cover this path.

### Remaining release evidence

This local result is ready for Pull Request and protected review. It does not
claim preview or release acceptance. A separately approved preview, the
representative full workout, and the installed-iPhone PWA interaction and
legibility check remain owner gates. VoiceOver is excluded by owner direction;
the automated semantic, keyboard/focus, accessible-name, contrast,
reduced-motion, and WebKit gates remain in force.

final result: passed locally; release acceptance pending owner gates
