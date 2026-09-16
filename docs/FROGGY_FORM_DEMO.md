# Froggy form viewer pilot

The optional viewer covers twenty-three reviewed catalog identities across twenty-two demonstrations with explicit demonstrated setups. Each uses a silent six-second loop across four presentation surfaces:

| Exercise | Media modes | Current export |
| --- | --- | --- |
| Incline Dumbbell Curl | Pulse / steady / clean | 1080 square, accepted presentation |
| Incline Barbell Bench Press | Steady | 800×720 local preview |
| Wide-Grip Lat Pulldown | Steady / clean | 800×720 local preview |
| Kettlebell Goblet Squat | Steady / clean | 800×720 local preview |
| Romanian Deadlift | Pulse / steady / clean | 800×720 local preview |
| Barbell Bench Press | Steady / clean | 800×720 local preview |
| Barbell Back Squat | Pulse / steady / clean | 1080 square, high bar |
| Barbell Overhead Press | Pulse / steady / clean | 800×720 local preview |
| Barbell Row | Pulse / steady / clean | 800×720 local preview |
| Bulgarian Split Squat | Pulse / steady / clean | 1080 square, left lead; repeat both sides |
| EZ-Bar Curl | Pulse / steady / clean | 1080 square |
| Cable Leg Curl | Pulse / steady / clean | 512 square, standing ankle cuff |
| Triceps Pushdown | Pulse / steady / clean | 512 square, rope attachment |
| Chest-Supported Dumbbell Row | Pulse / steady / clean | 512 square, 30° bench |
| Chest-Supported Dumbbell Reverse Fly | Pulse / steady / clean | 512 square, 30° bench |
| Single-Leg Dumbbell Calf Raise | Pulse / steady / clean | 512 square, forefoot on weight plate |
| Dead Bug | Pulse / steady / clean | 512 square, opposite arm and leg |
| Zottman Curl | Pulse / steady / clean | 512 square, palms up ascent / palms down descent |
| Kettlebell Suitcase Carry | Pulse / steady / clean | 512 square, one-hand walking carry |
| Dumbbell Lateral Raise | Pulse / steady / clean | 512 square, standing upright |
| Dumbbell Bench Press | Pulse / steady / clean | 512 square, flat bench |
| Dumbbell Overhead Triceps Extension / Single-Dumbbell Overhead Triceps Extension | Pulse / steady / clean | 512 square, seated, one fixed dumbbell held with both hands |

Consistent final-resolution finishing remains for the 800×720 and 512-square clips. No unavailable mode is offered. Presentation surfaces:

- Program exercise card: the Froggy thumbnail toggles the inline preview open/closed; the corner expand control opens a dialog.
- Today day preview: the Froggy thumbnail in Preview planned exercises (including another day's Planned exercises list) opens the same dialog before a workout starts. Unsupported exercises retain their existing icons; viewing form does not start a workout or change the selected day.
- Active workout exercise card: the Froggy thumbnail opens a dialog without navigation.
- Exercise picker inventory: a static availability label in results, with the
  same inline viewer opening automatically in exercise details. There is no separate inventory route.

Opening the preview starts silent playback. Tapping the image or using its
keyboard-accessible control pauses/resumes it, with a small Paused label and no
central play icon. A brief first-opening hint explains the gesture. If autoplay
is blocked, the corner label says Tap to play. The top DO/AVOID banner cycles
once per complete six-second repetition. DO uses a full green banner; AVOID uses a
full red banner, both with white text and distinct check/cross icons. Each new
message reveals the entire banner with a brief left-to-right wipe, including
DO-to-DO changes. Reduced-motion preference disables that transition.

Position, speed and pulse/steady/no highlights remain in Playback options.
Reduced-motion preference defaults to steady highlights. Fixed text labels use
exported camera-projected markers to track the body. Two neutral form callouts remain visible throughout every repetition, independent of the banner. Copy, target bones, label positions and references are specific to each exercise. Their backgrounds use 78% opacity with
fully opaque text. White connectors have dark outlines and retain their stroke
width at small preview sizes; outlined endpoint dots clarify the target.
The curl uses a shared 1.1× bottom-right framing transform for the video and
tracking coordinates, shifting the movement left while retaining its proportions.
The callout labels sit farther inside the right edge. The centred banner is
independent of this composition; source media and thumbnail are unchanged. Text and callouts are
HTML/SVG over the raw video. Media failure keeps text guidance available with
Retry video. A local error boundary contains player or lazy-module failures.

The original curl thumbnail was rendered from the accepted clean Blender scene,
frame 48, with only the floor hidden; the source scene was not saved or changed.
The thumbnail uses a tight upper-body crop to emphasize the arms, dumbbells and
bench angle rather than the feet and bench base.
Only opening a viewer loads its player and video. Goblet squat, incline curl and seated overhead extension thumbnail buttons have optional animated icons; other thumbnails and inventory result labels remain static.
Closing, scrolling the player out of view, or hiding the page pauses it. Returning
to view resumes unless explicitly paused. Expansion retains position, settings,
and the user's pause choice. The workout remains mounted underneath; this viewer
does not write workout state or control its timer.

## Identity and rollout boundary

`FROGGY_FORM_DEMO_PILOT=true` enables the server-side presentation mapping. The
flag is off by default. The resolver requires a reviewed global catalog entry,
an exact allowlisted variant key and load type, and matching laterality and
attributes. Bilateral variants require an empty attribute object. Unilateral
variants require exactly `{ laterality: "unilateral" }`, except the kettlebell
suitcase carry also accepts migration 0087's empty attribute object with its
required `isUnilateral=true` field. This supports the migrated and seeded
representations without rewriting catalog records or admitting other variants.
`src/lib/froggy-form-demo.ts` is the authoritative list of all twenty-three bindings.
Renamed display labels do not affect matching; related or conflicting variants
fail closed. The generic cable-leg-curl and triceps-pushdown entries explicitly
disclose their demonstrated standing ankle-cuff and rope setups. The generic dumbbell overhead extension and explicit single-dumbbell entry share the disclosed seated, two-handed demonstration; the mapping does not rewrite either catalog entry. Two-dumbbell, single-arm, cable and explicitly conflicting setup attributes remain excluded. Flat dumbbell
bench and standing lateral raise remain distinct from incline and rear-delt
variants. Database UUIDs are not portable matching keys.
The descriptor binds the asset key to the current database exercise ID; stale
metadata after replacement cannot display the old exercise's demo.

Program templates, discovery results and active session reads carry optional
presentation metadata. No schema, prescriptions, performed history, imports,
calculations, Coach decisions or production data are changed. Existing approved
reference media remains the fallback for exercises outside this pilot.

## Ownership

- `src/lib/froggy-form-demo.ts`: exact variant eligibility and bound identity.
- `src/lib/froggy-form-config.ts`: per-exercise cues, modes, source links and composition.
- `src/services/froggy-form-demo.ts`: opt-in server flag.
- `src/components/exercises/froggy-form-demo.tsx`: entry and dialog lifecycle.
- `src/components/exercises/froggy-form-player.tsx`: shared lazy player.
- `src/components/exercises/froggy-thumbnail.tsx`: optional visible-only sprite playback and static fallback.
- `src/lib/froggy-*-anchors.json`: 144-frame camera tracks; contained-video letterboxing and framing are also applied to marker coordinates.
- `public/exercise-media/froggy/`: versioned, portable raw clips,
  static posters and attribution. No local workstation URLs are shipped.

Source assets credit Snow Rig © Blender Foundation, CC BY 4.0; see the asset
attribution files and viewer reference disclosure. Appearance, equipment, motion
and educational materials are modified; the native rig is retained. No source
exercise video or third-party motion-capture file is redistributed. Exercise
references are linked in the viewer configuration, with tightly paraphrased cues.
Muscle highlights and moving pointers are schematic. These previews have not
received independent qualified instructional certification. Source Blender
projects and private review chronology are not part of the application bundle.

## Release operation

The same versioned files are delivered with the application from `public/`;
there is no localhost media dependency or additional storage integration.
These reusable character assets are public static files, even when the viewer
flag is off. They must not contain private workout information. The flag controls
presentation only and is not an asset access-control mechanism.

After the normal protected pull-request checks and an authorized deployment,
set `FROGGY_FORM_DEMO_PILOT=true` in the intended application environment and
redeploy. Leave authentication, database and test-login settings unchanged.
Never run the synthetic fixture against a hosted or live database. Verify one
supported preview in Program, exercise details and an active workout, including
media range responses, pause, dismissal and preservation of entered values.
If rollback is needed, unset the flag and redeploy: existing reference-media
presentation returns without a data migration. Already-open clients should
reload to receive the new server-side mapping.

## Local verification

Build with `npm run build`. Then run:

```sh
E2E_PORT=3185 node scripts/run-e2e-server.mjs --production --froggy-form-demo
```

This uses the existing disposable database harness, enables the pilot only in
that process, and creates a synthetic Program with all twenty-three supported catalog entries across six review days plus an unsupported dumbbell row for `owner@example.com`. Open
`http://127.0.0.1:3185/sign-in` and use Dev login. The fixture refuses a remote
DATABASE_URL and requires E2E_DEV_LOGIN plus the pilot flag. Stop the harness to
remove its disposable data. A short TMPDIR symlink can point to an external disk
when longer paths exceed the operating system's socket-path limit.

Focused checks:

```sh
npx vitest run tests/unit/froggy-form-demo.test.ts tests/unit/froggy-thumbnail.test.tsx tests/unit/program-presentation.test.ts tests/unit/program-presentation-service.test.ts tests/unit/exercise-card-component.test.tsx
npm run typecheck
npm run lint
npm run build
npm run docs:check
```

Browser review must cover Program inline playback/expansion, inventory browsing,
active workout draft and timer preservation, Escape/focus return, narrow screens,
reduced motion, media failure/retry, and variant replacement. Production release
and additional exercises remain separate work.

See [the local pilot review](FROGGY_FORM_DEMO_QA.md) for observed checks and
explicit coverage limits.

## Cue playback

Do/Avoid guidance advances from presented video-frame wraps using each clip's
actual duration. Loop detection does not depend on a six-second clip or the
browser's seeking flag during automatic looping. Manual scrubbing, mode changes
and viewer remounts reset the playback sample without treating a seek as a rep.
The existing guidance order, media and paused state remain authoritative.
Visible, unpaused previews request playback once metadata is available;
metadata-only preload does not have to reach `canplay` before playback starts.
Hidden previews and an explicit pause still prevent automatic playback.
