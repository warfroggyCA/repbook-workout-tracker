# Active Workout Phase 5 QA evidence

These images are running-product evidence for Phase 5 of the
[Active Workout North Star](../../ACTIVE_WORKOUT_NORTH_STAR.md). They are not
new target artboards.

- Starting baseline: public `main` at
  `601e9e74d7b5ca26e4b0b03b21cf99cdc137ce07`
- Captured: 2026-09-04
- Data: disposable synthetic BA workout fixtures; no owner or production data
- Browser: Chromium, America/Toronto, reduced motion, one CSS pixel per image
  pixel
- Default portrait state: 390 by 844 at Repbook's 115% default text size
- Dark evidence: files `11` through `13`

| File | Proven state |
|---|---|
| `01-set-entry-390x844-115.jpg` | Editable current set and compact ledger |
| `02-rest-running-390x844-115.jpg` | Neutral, nonblocking running rest |
| `03-rest-complete-390x844-115.jpg` | Brief completed-rest handoff |
| `04-equipment-conflict-390x844-115.jpg` | Named equipment conflict and truthful actions |
| `05-set-entry-390x844-145.jpg` | Current set at 145% text |
| `06-rest-running-390x844-145.jpg` | Running rest at 145% text |
| `07-set-entry-320x700-145.jpg` | Narrow-height 145% stress case |
| `08-saving-390x844-115.jpg` | Nonblocking set-save pending state |
| `09-failed-390x844-115.jpg` | Exact retained result with retry and discard |
| `10-keyboard-390x844-115.jpg` | Safe post-action keyboard focus state |
| `11-landscape-844x390-115.jpg` | Dark landscape with fixed actions reachable |
| `12-superset-390x844-115.jpg` | Exact current and next superset member |
| `13-correction-390x844-115.jpg` | Reviewed correction before commit |
| `14-skip-replace-390x844-115.jpg` | Skipped exercise with replace, continue, and restore |
| `15-finish-review-390x844-115.jpg` | Early Finish review and reason requirement |

## Complete session-state evidence

| Session state | Browser evidence |
|---|---|
| Preparation | `superset-equipment-preparation.spec.ts` |
| Structured warm-up | `active-workout-north-star-phase0.spec.ts` and `v2-t04-warmup-occurrences.spec.ts` |
| Set entry | Phase 5 image `01` |
| Set save pending | Phase 5 image `08` |
| Rest running / complete | Phase 5 images `02`, `03`, and `06` |
| Equipment decision | Phase 5 image `04` |
| Skip / replace decision | Phase 5 image `14` and `v2-gauntlet-b-live-workout.spec.ts` |
| Correction | Phase 5 image `13` |
| Offline retention | `active-workout-north-star-phase5.spec.ts` and `v2-u01-active-workout-hierarchy.spec.ts` |
| Failure recovery | Phase 5 image `09`; the same journey proves reload and discard |
| Superset transition | Phase 5 image `12` and `v2-t05-execution-semantics.spec.ts` |
| Early Finish review | Phase 5 image `15` |
| Ready to finish | `v2-t05-execution-semantics.spec.ts` |
| Completion pending | `active-workout-north-star-phase5.spec.ts` holds the Finish request and asserts **Saving workout…** |
| Completed handoff | The same Phase 5 journey verifies the exact finished History route |

The Phase 5 correction journey also performs a real encrypted safety snapshot
and record-version restore, then verifies the restored provenance back in the
active ledger. Existing focused gates retain browser evidence for added sets,
workout-only exercises, automatic retry, technical skip failure, note and pain
disclosures, and the full skip/replace/continue flow.

Regenerate this evidence only against a disposable local fixture:

```sh
npm run build
UPDATE_ACTIVE_WORKOUT_PHASE5_QA=1 npm run test:e2e:active-workout-north-star
```

Without the update variable, the same command verifies behavior but does not
overwrite these checked-in images. Never point this suite at preview or
production data.
