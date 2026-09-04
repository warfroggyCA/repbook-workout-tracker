# Active Workout Phase 6 integration evidence

These images are running-product evidence for the Phase 6 integration
Gauntlet in the
[Active Workout North Star](../../ACTIVE_WORKOUT_NORTH_STAR.md). The approved
artboards in `../active-workout-north-star/` remain the visual direction; these
files show the complete application after integration.

- Starting baseline: public `main` at
  `45f392fe0ab28749270cc792cec28bb1e0edca82`
- Captured: 2026-09-04
- Data: disposable synthetic BA workout fixtures; no owner or production data
- Browser: Chromium, America/Toronto, reduced motion, one CSS pixel per image
  pixel
- Default portrait state: 390 by 844 at Repbook's 115% default text size
- Dark evidence: files `11` through `13`

| File | Proven state |
|---|---|
| `01-set-entry-390x844-115.jpg` | Exact current-exercise landmark, editable set, and compact ledger |
| `02-rest-running-390x844-115.jpg` | Neutral, nonblocking running rest with exercise context |
| `03-rest-complete-390x844-115.jpg` | Brief completed-rest handoff |
| `04-equipment-conflict-390x844-115.jpg` | Named equipment conflict and truthful actions within its exercise |
| `05-set-entry-390x844-145.jpg` | Current exercise and set entry at 145% text |
| `06-rest-running-390x844-145.jpg` | Running rest and exact exercise context at 145% text |
| `07-set-entry-320x700-145.jpg` | Narrow-height 145% landmark and control stress case |
| `08-saving-390x844-115.jpg` | Nonblocking set-save pending state |
| `09-failed-390x844-115.jpg` | Exact retained result with retry and discard |
| `10-keyboard-390x844-115.jpg` | Safe post-action keyboard focus state |
| `11-landscape-844x390-115.jpg` | Dark landscape with fixed actions reachable |
| `12-superset-390x844-115.jpg` | Exact current and next superset member |
| `13-correction-390x844-115.jpg` | Reviewed correction before commit |
| `14-skip-replace-390x844-115.jpg` | Skipped exercise with replace, continue, and restore |
| `15-finish-review-390x844-115.jpg` | Early Finish review and reason requirement |
| `16-configuration-incomplete-390x844-115.jpg` | Named incomplete saved-machine setup with its exact missing fields and one truthful setup action |

The seven numbered states shared with the approved artboards are also retained
as equal-size side-by-side comparison images, with the artboard on the left and
the running product on the right:

- `01-set-entry-390x844-115-comparison.jpg`
- `02-rest-running-390x844-115-comparison.jpg`
- `03-rest-complete-390x844-115-comparison.jpg`
- `04-equipment-conflict-390x844-115-comparison.jpg`
- `05-set-entry-390x844-145-comparison.jpg`
- `06-rest-running-390x844-145-comparison.jpg`
- `07-set-entry-320x700-145-comparison.jpg`

The written North Star contract governs where the real product intentionally
carries more context than a static artboard.

The Phase 6 code also distinguishes an exact saved machine whose required
geometry is incomplete from equipment that is unavailable or incompatible.
The sixteenth browser capture proves its named decision, missing-field copy,
blocked Log state, dock-to-decision focus, and **Complete equipment setup**
navigation. Focused resolver, presentation, component, guidance,
session-runner, and server-action tests prove that the incomplete state cannot
be recorded as an unavailable-equipment cause through either an exercise-level
choice or a set-level offline replay. Rejected queued changes remain visible for
review. Retained broad identity is applied before incomplete candidates are
named, automatic selection uses the same canonical option list as the screen,
and a post-preflight equipment change cannot write a stale occurrence result.
No migration, historical rewrite, Program change, or production-data operation
is involved.

Regenerate this evidence only against a disposable local fixture:

```sh
npm run build
UPDATE_ACTIVE_WORKOUT_PHASE6_QA=1 npm run test:e2e:active-workout-north-star
npm run active-workout:phase6-comparisons
```

Without the update variable, the same command verifies behavior but does not
overwrite these checked-in images. Never point this suite at preview or
production data. These local captures do not replace owner acceptance in a new
preview, a representative full workout, or the installed-iPhone PWA check.
