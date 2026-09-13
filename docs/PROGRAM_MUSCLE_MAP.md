# Program muscle coverage

The authenticated `/program/muscles` screen is linked from Program. It reads the
active owner's saved Program version, exercise identities and current working-set
prescriptions through `getActiveProgramPresentation`. It does not use a sample
Program in application code and has no mutation endpoint.

## Meaning

- Red and the translucent number are **planned direct working sets** across
  selected days. Reviewed exact variants use the coverage-v2 target/support policy;
  unmatched variants retain saved primary/secondary catalog roles with a warning.
  The number is not an exercise count, per-side count, or an activation layer.
  One number per paired region avoids implying separate left/right prescriptions.
- Supporting sets never become full direct sets. A duplicate or aliased muscle is
  counted once per slot; primary takes precedence when both roles name it.
- Repeated occurrences of an exact exercise remain separate slots. Warm-ups,
  load, reps, exercise order and supersets do not multiply the count. Unilateral
  prescriptions are not doubled by side. Timed prescriptions count their saved
  sets, without converting seconds into sets.
- One set can appear under several muscles. Summing muscle totals is not the
  total number of Program sets.
- Colour bands are fixed at 1–3, 4–6, 7–9 and 10+ direct sets. They never rescale
  with the selected days. Zero mapped direct sets leave the skin unchanged.
- Days with direct work counts distinct saved Program days with valid direct
  sets. It is not weekly frequency; schedules may use a different rotation.
- These are planned coverage counts, not measured activation, effectiveness,
  training adequacy, an ACSM score or a Coach recommendation.

Missing or invalid prescriptions contribute no invented sets and remain flagged.
Unknown muscle labels, broad unspecified groups and deep muscles retain textual
counts and details without an invented surface region. Missing primary, unreviewed
coverage roles and unreviewed catalog records are disclosed. An empty
supporting list means no supporting mapping is recorded, not no involvement.
Catalog review does not certify the anatomical role classification.

## Interaction and freshness

A prominent, touch-sized Back to Day button returns to the saved day that opened
this map. Ordinary map entry uses Back to Program. The short How to read guide
explains colours and selection in everyday language; exercise-specific mapping
notes remain available in a separate nested disclosure.


Day buttons independently toggle the shading; All days toggles all/none. Muscle
selection is additive and independent of days. A second tap deselects and clears
the temporary hover/focus preview immediately, even while the pointer remains on
the region. Keyboard focus retains a distinct dashed indicator. The native
muscle selector can inspect any region, including unmapped labels, without
requiring a day selection. Select/Deselect is a large-touch-target alternative.
Selected chips focus an already selected muscle. Clear all resets both selection
sets and the detail filter.

Details always refer to the full saved Program, with links to each relevant day.
The three count tiles filter the exercise list to direct, supporting or direct
work grouped by day; pressing the active tile again restores all work. The map
and selection controls stay in place while the detail pane scrolls. Changing the
inspected muscle resets only that pane to its start. Very short viewports can
scroll the page to preserve access to controls rather than clip them.

The screen reloads server data on Refresh and on returning to the visible tab.
Program navigation uses a fresh read; there is no persisted aggregate or second
Program state store. A version update for the same Program retains muscle
selections, and day selections use lineage IDs. A different active Program resets
the screen's state. This screen neither reads nor rewrites completed History,
active workout snapshots, recommendations or recorded sets.

## Shared foundation

- `src/lib/exercise-muscle-coverage.ts`: coverage-v2 exact-variant role policy and
  reference notes, resolved server-side from existing strict identity guards,
  independently of the exercise-demo pilot flag. Stored catalog arrays remain
  unchanged; no database backfill is needed.
- `src/lib/muscle-coverage.ts`: display aliases, stable labels, pure aggregation,
  role distinction and fixed colour bands. `aggregateMuscleWork(work, dayIds)`
  supports one day, multiple days, all days (omitted filter), or none (empty set).
- `src/lib/froggy-muscle-regions.json`: front/back paths and numeric-label anchors.
- `src/components/muscle-map/froggy-muscle-map.tsx`: reusable artwork surface,
  keyboard/touch region toggles, teal selection plus white contrast outline.
  Omitting `onToggle` yields a noninteractive view.
- `src/components/muscle-map/program-muscle-map.tsx`: full-screen selection,
  inspection and filters.
- `public/muscle-map/`: portable original AI-generated mannequin concept artwork.

Calf overlays are restricted to the rear view and inset to the visible calf
silhouette; the front shin is not painted as calf coverage.

The art is an approved raster concept with **23 schematic surface regions**, not a
rotatable anatomical 3D model. New regions distinguish anterior/lateral/posterior
delts, anterior forearm flexors, posterior extensors, brachioradialis, obliques,
upper traps, serratus, hip adductors, side glutes and tibialis anterior. The broad
catalog labels shoulders, core and forearms are deliberately text-only rather
than silently attributing sets to every subdivision. Transversus, rotator cuff
and hip flexors are also text-only. Unworked surface regions stay skin coloured
and remain available to mouse, touch and keyboard selection.

Chest, quadriceps, hamstrings and calves remain grouped. Upper/middle back combines
scapular retractors; side-glute and forearm patches represent groups, not every
individual muscle or its precise attachment. Overlays approximate a stylized
concept silhouette, and the model cannot establish anatomical certification.
Incline pressing keeps one chest count and explains clavicular emphasis without
invented regional percentages or isolated upper-chest coverage. A calf synergy
in a knee curl refers to gastrocnemius, not every member of the calf group.

The full map and compact day summaries use transparent SVG silhouette clips
around the same original image. The full map uses a softly blurred gym
background with a neutral veil and decorative foot shadows. No character
regeneration or alternate muscle geometry is involved. Existing clothed exercise-demo files, motion,
bindings and configuration are unchanged. Gap analysis, suggestions and automatic Program changes remain deferred.

## Compact workout-day summaries

Program's selected-day heading, Today's planned-day heading, and Today's
alternate-day choices show a small transparent front/back pair for days that
have saved exercise slots. Empty/rest days do not imply a zero-work silhouette.
The summary is a link with a visible "Muscle details" caption and an accessible
text equivalent listing planned direct sets. It has no animation, tiny muscle
hit targets, or unreadable set numbers. Supporting work and mapping limitations
remain available in the full map; unworked regions stay skin coloured.

`DayMuscleSummary` uses the same `programMuscleWork`, `aggregateMuscleWork`,
regions and fixed red bands as the full map. `templatePresentationSource` shares
the saved-template projection between Today and Program, including coverage-v2
roles and catalog fallback; Today needs no additional database read. Changed
saved exercises and prescriptions are reflected on the next server read, while
Program day-tab changes immediately select the matching summary. No aggregate
is persisted and unsaved drafts are not displayed as the saved Program.

Tapping or keyboard-activating the summary opens `/program/muscles?day=<lineageId>`
with only that currently owned day selected. Ordinary map navigation still starts
with all days. A new day-link navigation resets the initial day filter; in-map
filters remain interactive and a refresh preserves selections. A removed or
foreign day ID shows all current days with a visible explanation. Duplicate query
parameters are ignored. Day identity uses lineage, not a title or version-specific
template ID. Workout Start and exercise-form controls remain separate actions.

`src/lib/froggy-muscle-silhouettes.json` supplies reusable native SVG cutout paths
in the existing 1774×887 image coordinate system. Both artwork sizes clip the image and muscle layers together. Original image
pixels and exercise-demo assets are preserved. App-facing labels use neutral
terms such as “Your muscle coverage” and “Exercise form”. The cutout boundaries
are visual silhouettes, not new anatomical regions or anatomical certification.

The Program edit action moves below the title on narrow screens so it cannot
squeeze the title beside the miniature. Each summary remains at least 84×104 CSS
pixels, with a visible keyboard focus outline. Full-map disclosures also apply to
these miniatures, including text-only deep muscles.

### Compact-summary verification

Run `tests/unit/day-muscle-summary.test.tsx`,
`tests/unit/program-muscle-map-route.test.tsx`, and
`tests/unit/today-form-preview.test.tsx` alongside the shared coverage and
presentation suites below. Verify Today current/alternate previews, Program day
switching, distinct summary versus exercise-form actions, keyboard link activation,
one-day destination, stale-day explanation, browser Back, and desktop/390px/320px
layouts with the disposable fixture. Physical iPhone Safari and installed-PWA
acceptance remains a separate follow-up, including touch accuracy and resume.

## Coverage review and sources

Coverage-v2 covers the 21 existing exact demo variants. Direct means a chosen
training target; supporting includes synergists and selected stabilizers. This
boundary is an editorial interpretation, not a universally standardized division
or a measured activation threshold. A compound exercise can train an assisting
muscle without its sets being counted as full direct sets here. Supporting lists
are not an exhaustive inventory of every stabilizer. The UI exposes a per-exercise
“Why this mapping?” note and the existing exercise reference.

The policy reuses identity eligibility from `matchFroggyFormDemo(exercise, true)`
to avoid a second set of variant-matching rules. No environment flag is consulted.
Unknown, custom, unreviewed or conflicting identities fall back to their saved
catalog mappings. Future animation-version changes must retain or explicitly
update coverage policy keys; the exhaustive TypeScript record guards this.

Reference basis (accessed 2026-09-10):

- [NCBI forearm anatomy](https://www.ncbi.nlm.nih.gov/books/NBK536975/): flexor and
  extensor compartments and the distinct elbow-flexion role of brachioradialis.
- [ACE exercise taxonomy and lateral raise](https://www.acefitness.org/resources/everyone/exercise-library/26/lateral-raise/): practical muscle groups and shoulder mechanics.
- [NASM incline press](https://www.nasm.org/resource-center/exercise-library/incline-barbell-bench-press),
  [bench press](https://www.nasm.org/resource-center/exercise-library/barbell-bench-press),
  [pulldown](https://www.nasm.org/resource-center/blog/training/the-biomechanics-of-the-lat-pulldown-muscles-grip-and-form),
  and [goblet squat](https://www.nasm.org/resource-center/exercise-library/goblet-squat).
- Catalyst Athletics [RDL](https://www.catalystathletics.com/exercise/101/Romanian-Deadlift-RDL/),
  [squat](https://www.catalystathletics.com/exercise/77/Back-Squat/),
  [press](https://www.catalystathletics.com/exercise/90/Press/),
  [row](https://www.catalystathletics.com/exercise/171/Bent-Row/), and
  [split squat](https://www.catalystathletics.com/exercise/173/Bulgarian-Split-Squat/).
- Muscle & Strength [incline curl](https://www.muscleandstrength.com/exercises/incline-dumbbell-curl.html),
  [EZ curl](https://www.muscleandstrength.com/exercises/ez-bar-curl.html),
  [Zottman curl](https://www.muscleandstrength.com/exercises/zottman-curl.html),
  [reverse fly](https://www.muscleandstrength.com/exercises/dumbbell-reverse-fly-on-incline-bench.html), and
  [dumbbell bench](https://www.muscleandstrength.com/exercises/dumbbell-bench-press.html).
- [Standing cable curl](https://exrx.net/WeightExercises/Hamstrings/CBStandingLegCurl),
  [rope pushdown](https://www.strengthlog.com/tricep-pushdown-with-rope/),
  [supported row](https://www.muscleandfitness.com/exercise/workouts/back-exercises/thirty-degree-incline-dumbbell-row/), and
  [single-leg calf raise](https://www.muscleandfitness.com/exercise/workouts/leg-exercises/single-leg-standing-dumbbell-calf-raise/).
- [Harvard dead bug](https://www.health.harvard.edu/exercise-and-fitness/the-many-benefits-of-the-dead-bug) and
  [ACE kettlebell carry reference](https://www.acefitness.org/continuing-education/certified/october-2022/8147/kettlebells-kick-butt-in-more-ways-than-one/).

Interpretation limits: grip and neutral-wrist stabilization are supporting roles,
including EZ curls whose reference lists no secondary muscles. The deliberately
pronated Zottman descent is treated as a brachioradialis target; its reference
lists forearms broadly as secondary, a difference disclosed in the UI. The carry
uses obliques as the chosen anti-lateral-flexion target; this does not isolate them.
No EMG percentages or ACSM adequacy scores are inferred from these descriptions.

## Verification

```sh
npx vitest run tests/unit/exercise-muscle-coverage.test.tsx tests/unit/muscle-coverage.test.ts tests/unit/muscle-coverage-db.test.ts tests/unit/program-presentation.test.ts tests/unit/program-presentation-service.test.ts tests/unit/froggy-form-demo.test.ts
npm run typecheck
npm run lint
npm run build
npm run docs:check
```

The database test compares calculated direct/supporting counts with an independent
SQL sum over saved prescriptions, checks owner scoping, publishes an updated
Program through the existing draft/review workflow, and verifies the retained old
prescriptions. Pure tests cover fixed colour bands, no days, one day, duplicated
aliases, role overlap, repeated exact exercises, missing mappings and invalid sets.

For signed-in browser verification use the existing disposable fixture harness:

```sh
E2E_PORT=3197 node scripts/run-e2e-server.mjs --production --froggy-form-demo
```

Use Dev login with `owner@example.com`, then open `/program/muscles`. The fixture
contains synthetic data. Verify desktop and narrow phone layout, direct taps,
keyboard toggles, forearm inspection, direct-set numbers, red plus selection contrast, All days, additive muscles, Clear
all, the three detail filters, no-day inspection, disclosure expansion, refresh
and Program-day links. Do not seed or mutate a live database for verification.

Empty detail filters describe the selected role in plain language. If the
other role has exercises, a button opens that list. A zero direct-role result
does not imply missing exercise mappings or no muscle involvement. Mapping
limitations remain available in Exercise notes.

The full map uses a softly blurred gym background with a neutral veil. Status
and legend text have light backings for contrast. The background is decorative
CSS and cannot intercept pointer events. Compact workout-day summaries remain
transparent and do not load the gym image. Visible front/back captions are
omitted; accessible view labels remain.
