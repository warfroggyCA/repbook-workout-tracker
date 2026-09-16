import {
  matchFroggyFormDemo,
  type FroggyCatalogIdentity,
  type FroggyDemoKey,
} from "./froggy-form-demo";
import { FROGGY_FORMS } from "./froggy-form-config";
import type { MuscleRegion } from "./muscle-coverage";

export type CoverageReview = { version: string; source: string; note: string };
export type ReviewedMuscleMapping = {
  primary: MuscleRegion[];
  supporting: MuscleRegion[];
  coverageReview: CoverageReview;
};
type Roles = {
  primary: MuscleRegion[];
  supporting: MuscleRegion[];
  note: string;
};
const roles = (
  primary: MuscleRegion[],
  supporting: MuscleRegion[],
  note: string,
): Roles => ({ primary, supporting, note });
const grip: MuscleRegion[] = ["forearmflexors", "forearmextensors"];
const press = roles(
  ["chest"],
  ["triceps", "frontdelts"],
  "Chest is the target; elbow extension and front-deltoid assistance are supporting work. Flat pressing does not isolate a lower-chest region.",
);
const squat = roles(
  ["quads", "glutes"],
  ["adductors", "hamstrings", "erectors", "abs", "obliques"],
  "Knee and hip extension target quadriceps and glutes. Adductors assist hip extension; the trunk braces. This grouping does not estimate individual muscle-head activation.",
);
const row = roles(
  ["lats", "upperback"],
  ["biceps", "brachioradialis", "reardelts", ...grip],
  "Shoulder extension and scapular retraction target lats and the middle-back group. Elbow flexors and grip assist; wrist stabilization is not counted as direct wrist training.",
);
const curl = roles(
  ["biceps"],
  ["brachioradialis", ...grip],
  "Elbow flexion targets biceps. Outer-forearm assistance, finger grip and wrist stabilization are supporting roles, not additional direct wrist sets.",
);

/** Versioned editorial target/assistance policy, not EMG measurements or certification.
 * Sources describe exercise mechanics; the direct/support boundary and anatomical
 * subdivisions are conservative interpretation. See docs/PROGRAM_MUSCLE_MAP.md.
 */
export const REVIEWED_COVERAGE: Record<FroggyDemoKey, Roles> = {
  "seated-overhead-triceps-extension-v155": roles(
    ["triceps"],
    [],
    "Elbow extension targets triceps. The demonstrated setup is seated with one dumbbell held in both hands. Supporting regions are not classified for this demonstration; the map does not estimate individual triceps-head activation.",
  ),
  "incline-dumbbell-curl-v102": curl,
  "incline-press-v107": {
    ...press,
    note: "Incline pressing emphasizes the clavicular chest region but still involves the broader pectoralis major. The map counts chest once, rather than inventing a percentage or an exclusively upper-chest set.",
  },
  "lat-pulldown-v107": roles(
    ["lats"],
    ["upperback", "reardelts", "biceps", "brachioradialis", ...grip],
    "Pronated pulldown: lats are the target; elbow flexors, scapular muscles and grip assist. Grip width and execution can change emphasis.",
  ),
  "goblet-squat-v107": squat,
  "romanian-deadlift-v107": roles(
    ["hamstrings", "glutes"],
    ["erectors", "adductors", "abs", "obliques", "lats", ...grip],
    "Hip extension targets hamstrings and glutes. The back and trunk hold position, lats keep the bar close, and the hands maintain grip.",
  ),
  "barbell-bench-v108": press,
  "back-squat-v108": squat,
  "overhead-press-v108": roles(
    ["frontdelts", "sidedelts"],
    ["triceps", "uppertraps", "serratus", "abs", "obliques"],
    "Deltoids are the selected targets. Triceps assist elbow extension; trapezius and serratus contribute scapular rotation, and the trunk braces.",
  ),
  "barbell-row-v108": {
    ...row,
    supporting: [...row.supporting, "erectors", "abs", "obliques"],
  },
  "bulgarian-split-squat-v109": {
    ...squat,
    supporting: [...squat.supporting, "abductors", ...grip],
    note: "Quadriceps and glutes drive the split squat; side-glute stabilization and grip remain supporting. A prescribed set is counted once, not doubled for two sides.",
  },
  "ez-bar-curl-v109": curl,
  "standing-cable-leg-curl-v117": roles(
    ["hamstrings"],
    ["calves", "abductors", "obliques"],
    "Standing ankle-cuff knee flexion targets the hamstrings; gastrocnemius assists. The calf group is not a claim that every calf muscle performs knee flexion.",
  ),
  "rope-pushdown-v117": roles(
    ["triceps"],
    grip,
    "Elbow extension targets triceps; holding the rope and keeping wrists steady are supporting roles.",
  ),
  "chest-supported-row-v117": row,
  "chest-supported-reverse-fly-v117": roles(
    ["reardelts"],
    ["upperback", ...grip],
    "Shoulder horizontal abduction targets rear delts. Scapular retraction and holding the dumbbells are supporting roles.",
  ),
  "single-leg-dumbbell-calf-raise-v133": roles(
    ["calves"],
    ["abductors", ...grip],
    "Plantar flexion targets the calf group. Standing with a relatively straight knee emphasizes gastrocnemius; soleus is also involved. Balance and dumbbell grip support the movement.",
  ),
  "dead-bug-v133": roles(
    ["abs", "obliques", "deepabs"],
    ["hipflexors"],
    "Abdominal bracing is the exercise target, including the deep transversus. Hip flexors help position the legs. Deep muscles appear in details without a fabricated surface patch.",
  ),
  "zottman-curl-v133": roles(
    ["biceps", "brachioradialis"],
    grip,
    "Palms-up ascent targets biceps; the deliberately pronated descent loads the outer-forearm elbow flexor. We classify both as targets; the reference lists forearms broadly as secondary. Wrist and finger muscles remain supporting.",
  ),
  "kettlebell-suitcase-carry-v133": roles(
    ["obliques"],
    ["abs", "deepabs", "erectors", "abductors", "uppertraps", ...grip],
    "Resisting sideways trunk bending is the selected target. Grip and other postural muscles support the carry. This is an exercise-role interpretation, not a claim of isolated oblique loading.",
  ),
  "standing-dumbbell-lateral-raise-v138": roles(
    ["sidedelts"],
    ["uppertraps", "serratus", ...grip],
    "Raising the arms sideways targets the lateral deltoid. Scapular rotation and grip assist; front and rear delts are not automatically assigned full direct sets.",
  ),
  "flat-dumbbell-bench-press-v138": press,
};

/** Reuse existing strict identity guards, independently of the demo pilot flag.
 * Unknown/custom/conflicting variants retain their catalog mappings at the caller.
 * No display-name matching and no stored exercise or animation changes.
 */
export function reviewedExerciseMuscles(
  exercise: FroggyCatalogIdentity,
): ReviewedMuscleMapping | null {
  const match = matchFroggyFormDemo(exercise, true);
  if (!match) return null;
  const mapping = REVIEWED_COVERAGE[match.key];
  return {
    primary: [...mapping.primary],
    supporting: [...mapping.supporting],
    coverageReview: {
      version: "coverage-v2",
      source: FROGGY_FORMS[match.key].reference,
      note: mapping.note,
    },
  };
}
