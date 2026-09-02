# Active Workout Phase 0 baseline

These images record the current Active Workout implementation before the North
Star interface work begins. They are comparison evidence, not approved target
screens and not proof that the pictured behaviour is correct.

- Application baseline: public `main` at
  `091a526a887642e2c4cc197798c03a83317558ef`
- Captured: 2026-09-01
- Data: disposable synthetic BA workout fixture; no owner or production data
- Browser: Chromium, reduced motion, light mode, one CSS pixel per image pixel
- Target direction: `../active-workout-north-star/`

Files `01` through `07` correspond exactly to the seven approved North Star
reference names. The ordinary screens use the fixture's normal single-bar
inventory. File `04` is isolated in a separate disposable run with two
compatible Olympic bars so the existing equipment-choice state is reachable
without contaminating the common-path captures.

`10-keyboard-390x844-115.jpg` is additional characterization evidence. The
associated expected-failure browser test proves that the current focus handoff
lands on decrement controls: a second Enter shortens rest by 15 seconds, and an
Enter after dismissing rest changes the next set's load from 95 lb to 92.5 lb.
Phase 0 records that defect; it does not fix it.

Regenerate the evidence only when intentionally refreshing this baseline:

```sh
npm run build
UPDATE_ACTIVE_WORKOUT_PHASE0_BASELINE=1 npm run test:e2e:active-workout-north-star
```

Running the browser command without the update variable verifies the scenarios
and keeps generated artifacts under `output/playwright/`; it does not overwrite
these checked-in images. Common-path and keyboard artifacts use
`common-test-results/`, while the isolated two-bar equipment run uses
`equipment-test-results/`, so the second invocation cannot erase the first.
