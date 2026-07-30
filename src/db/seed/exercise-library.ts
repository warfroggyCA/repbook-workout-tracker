/**
 * Seeded exercise library (plan §12). Equipment entries are ALL required
 * together; `[type, minWeight]` means the owned item must reach that weight
 * at filter time (e.g. heavy DB rows vs. 35 lb dumbbells).
 */

import { expandedExerciseLibrary } from "./expanded-exercise-library";

export type EquipmentType =
  | "barbell"
  | "ez_bar"
  | "rack"
  | "bench"
  | "dumbbell"
  | "kettlebell"
  | "plates"
  | "bands"
  | "jump_rope"
  | "elliptical"
  | "pullup_bar"
  | "cable"
  | "machine"
  | "bodyweight"
  | "other"
  | "trap_bar"
  | "smith_machine"
  | "suspension"
  | "medicine_ball"
  | "stability_ball"
  | "foam_roller"
  | "sled"
  | "rowing_machine"
  | "stationary_bike"
  | "treadmill"
  | "stair_machine"
  | "dip_station"
  | "box"
  | "landmine"
  | "battle_rope";

export type MovementPattern =
  | "squat"
  | "hinge"
  | "horizontal_push"
  | "vertical_push"
  | "horizontal_pull"
  | "vertical_pull"
  | "lunge"
  | "carry"
  | "core"
  | "isolation_arms"
  | "isolation_shoulders"
  | "isolation_legs"
  | "conditioning"
  | "rotation"
  | "locomotion"
  | "olympic_lift"
  | "plyometric"
  | "mobility"
  | "stretch";

type LoadType =
  | "barbell"
  | "ez_bar"
  | "trap_bar"
  | "dumbbell"
  | "kettlebell"
  | "band"
  | "bodyweight"
  | "external";

export type SeedExercise = {
  name: string;
  pattern: MovementPattern;
  muscles: string[];
  loadType: LoadType;
  equipment: Array<EquipmentType | [EquipmentType, number]>;
  aliases?: string[];
  unilateral?: boolean;
  family?: string;
  secondaryMuscles?: string[];
  activityClass?:
    | "strength"
    | "conditioning"
    | "mobility"
    | "stretch"
    | "activation"
    | "warmup";
  metricType?:
    | "weight_reps"
    | "reps"
    | "assisted_reps"
    | "duration"
    | "distance_duration"
    | "activity";
  loadSemantics?:
    | "total"
    | "per_implement"
    | "bodyweight"
    | "added_weight"
    | "assistance"
    | "machine_stack"
    | "resistance_band"
    | "none";
  variantKey?: string;
  variantAttributes?: {
    angle?: string;
    position?: string;
    grip?: string;
    attachment?: string;
    laterality?: "bilateral" | "unilateral" | "alternating";
    assistance?: "none" | "weighted" | "assisted";
    machine?: string;
  };
  source?: {
    name: string;
    id?: string;
    url?: string;
    license?: string;
  };
  /**
   * Reviewed executable-equipment policy for this exact catalog variant.
   * Omission is deliberate: broad ownership remains the only catalog gate.
   */
  exactExecutionRequirement?: {
    requiredProfileKind:
      | "plate_loaded_implement"
      | "plate_loaded_machine"
      | "cable_machine";
    requiredAttachmentKind?:
      | "rope"
      | "straight_bar"
      | "lat_bar"
      | "v_bar"
      | "single_handle"
      | "ankle_cuff"
      | "other";
    requiresKnownGeometry: boolean;
    reviewNotes: string;
  };
};

const baseExerciseLibrary: SeedExercise[] = [
  // --- Squat ---
  { name: "Barbell Back Squat", pattern: "squat", muscles: ["quads", "glutes"], loadType: "barbell", equipment: ["barbell", "plates", "rack"], aliases: ["back squat", "bb back squat"] },
  { name: "Barbell Front Squat", pattern: "squat", muscles: ["quads", "glutes", "core"], loadType: "barbell", equipment: ["barbell", "plates", "rack"], aliases: ["front squat"] },
  { name: "Barbell Box Squat", pattern: "squat", muscles: ["quads", "glutes"], loadType: "barbell", equipment: ["barbell", "plates", "rack", "bench"], aliases: ["box squat"] },
  { name: "Goblet Squat", pattern: "squat", muscles: ["quads", "glutes"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["db goblet squat", "dumbbell goblet squat"] },
  { name: "Kettlebell Goblet Squat", pattern: "squat", muscles: ["quads", "glutes"], loadType: "kettlebell", equipment: ["kettlebell"], aliases: ["kb goblet squat"] },
  { name: "Kettlebell Front Squat", pattern: "squat", muscles: ["quads", "glutes", "core"], loadType: "kettlebell", equipment: ["kettlebell"], aliases: ["kb front squat"] },
  { name: "Dumbbell Squat", pattern: "squat", muscles: ["quads", "glutes"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["db squat"] },
  { name: "Leg Press", pattern: "squat", muscles: ["quads", "glutes"], loadType: "external", equipment: ["machine"] },
  { name: "Bodyweight Squat", pattern: "squat", muscles: ["quads", "glutes"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["air squat"] },

  // --- Hinge ---
  { name: "Conventional Deadlift", pattern: "hinge", muscles: ["hamstrings", "glutes", "back"], loadType: "barbell", equipment: ["barbell", "plates"], aliases: ["barbell deadlift", "conventional dl"] },
  { name: "Romanian Deadlift", pattern: "hinge", muscles: ["hamstrings", "glutes"], loadType: "barbell", equipment: ["barbell", "plates"], aliases: ["rdl", "romanian dl", "bb rdl"] },
  { name: "Dumbbell Romanian Deadlift", pattern: "hinge", muscles: ["hamstrings", "glutes"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["db rdl"] },
  { name: "Kettlebell Deadlift", pattern: "hinge", muscles: ["hamstrings", "glutes"], loadType: "kettlebell", equipment: ["kettlebell"], aliases: ["kb deadlift"] },
  { name: "Kettlebell Swing", pattern: "hinge", muscles: ["glutes", "hamstrings"], loadType: "kettlebell", equipment: ["kettlebell"], aliases: ["kb swing", "russian swing"] },
  { name: "Barbell Hip Thrust", pattern: "hinge", muscles: ["glutes"], loadType: "barbell", equipment: ["barbell", "plates", "bench"], aliases: ["hip thrust"] },
  { name: "Glute Bridge", pattern: "hinge", muscles: ["glutes"], loadType: "bodyweight", equipment: ["bodyweight"] },
  { name: "Good Morning", pattern: "hinge", muscles: ["hamstrings", "back"], loadType: "barbell", equipment: ["barbell", "plates", "rack"] },
  { name: "Band Pull-Through", pattern: "hinge", muscles: ["glutes", "hamstrings"], loadType: "band", equipment: ["bands"], aliases: ["band pull through"] },
  { name: "Back Extension", pattern: "hinge", muscles: ["back", "glutes"], loadType: "bodyweight", equipment: ["machine"], aliases: ["hyperextension"] },

  // --- Horizontal push ---
  { name: "Barbell Bench Press", pattern: "horizontal_push", muscles: ["chest", "triceps", "shoulders"], loadType: "barbell", equipment: ["barbell", "plates", "bench", "rack"], aliases: ["barbell flat bench press", "bb bench press"] },
  { name: "Incline Barbell Bench Press", pattern: "horizontal_push", muscles: ["chest", "shoulders", "triceps"], loadType: "barbell", equipment: ["barbell", "plates", "bench", "rack"], aliases: ["incline bench", "incline bb bench"] },
  { name: "Dumbbell Bench Press", pattern: "horizontal_push", muscles: ["chest", "triceps", "shoulders"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], aliases: ["db bench", "db bench press", "dumbbell press"] },
  { name: "Incline Dumbbell Press", pattern: "horizontal_push", muscles: ["chest", "shoulders", "triceps"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], aliases: ["incline db press", "incline dumbbell bench"] },
  { name: "Barbell Floor Press", pattern: "horizontal_push", muscles: ["chest", "triceps"], loadType: "barbell", equipment: ["barbell", "plates", "rack"], aliases: ["floor press"] },
  { name: "Dumbbell Floor Press", pattern: "horizontal_push", muscles: ["chest", "triceps"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["db floor press"] },
  { name: "Push-Up", pattern: "horizontal_push", muscles: ["chest", "triceps", "shoulders"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["pushup", "push up", "press up"] },
  { name: "Band Chest Press", pattern: "horizontal_push", muscles: ["chest", "triceps"], loadType: "band", equipment: ["bands"] },
  { name: "Dumbbell Fly", pattern: "horizontal_push", muscles: ["chest"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], aliases: ["db fly", "chest fly", "dumbbell flye"] },
  { name: "Cable Fly", pattern: "horizontal_push", muscles: ["chest"], loadType: "external", equipment: ["cable"], aliases: ["cable crossover"] },
  { name: "Chest Dip", pattern: "horizontal_push", muscles: ["chest", "triceps"], loadType: "bodyweight", equipment: ["machine"], aliases: ["dip", "dips"] },

  // --- Vertical push ---
  { name: "Barbell Overhead Press", pattern: "vertical_push", muscles: ["shoulders", "triceps"], loadType: "barbell", equipment: ["barbell", "plates", "rack"], aliases: ["barbell ohp", "barbell military press", "barbell strict press"] },
  { name: "Seated Dumbbell Shoulder Press", pattern: "vertical_push", muscles: ["shoulders", "triceps"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], aliases: ["seated db press", "db shoulder press", "dumbbell shoulder press"] },
  { name: "Standing Dumbbell Press", pattern: "vertical_push", muscles: ["shoulders", "triceps"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["standing db press"] },
  { name: "Arnold Press", pattern: "vertical_push", muscles: ["shoulders"], loadType: "dumbbell", equipment: ["dumbbell", "bench"] },
  { name: "Band Overhead Press", pattern: "vertical_push", muscles: ["shoulders", "triceps"], loadType: "band", equipment: ["bands"], aliases: ["band ohp"] },
  { name: "Pike Push-Up", pattern: "vertical_push", muscles: ["shoulders", "triceps"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["pike pushup"] },
  { name: "Kettlebell Press", pattern: "vertical_push", muscles: ["shoulders", "triceps"], loadType: "kettlebell", equipment: ["kettlebell"], aliases: ["kb press", "kb overhead press"], unilateral: true },

  // --- Horizontal pull ---
  { name: "Barbell Row", pattern: "horizontal_pull", muscles: ["back", "biceps"], loadType: "barbell", equipment: ["barbell", "plates"], aliases: ["barbell bent over row", "bb row"] },
  { name: "Pendlay Row", pattern: "horizontal_pull", muscles: ["back", "biceps"], loadType: "barbell", equipment: ["barbell", "plates"] },
  { name: "Dumbbell Row", pattern: "horizontal_pull", muscles: ["back", "biceps"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], aliases: ["db row", "one arm row", "single arm row", "kroc row"], unilateral: true },
  { name: "Chest-Supported Dumbbell Row", pattern: "horizontal_pull", muscles: ["back", "biceps"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], aliases: ["chest supported row", "incline db row"] },
  { name: "Inverted Row", pattern: "horizontal_pull", muscles: ["back", "biceps"], loadType: "bodyweight", equipment: ["rack", "barbell"], aliases: ["bodyweight row", "australian pull-up"] },
  { name: "Band Row", pattern: "horizontal_pull", muscles: ["back", "biceps"], loadType: "band", equipment: ["bands"], aliases: ["band seated row"] },
  { name: "Seated Cable Row", pattern: "horizontal_pull", muscles: ["back", "biceps"], loadType: "external", equipment: ["cable"], aliases: ["cable row"] },
  { name: "Kettlebell Row", pattern: "horizontal_pull", muscles: ["back", "biceps"], loadType: "kettlebell", equipment: ["kettlebell"], aliases: ["kb row"], unilateral: true },

  // --- Vertical pull ---
  { name: "Pull-Up", pattern: "vertical_pull", muscles: ["back", "biceps"], loadType: "bodyweight", equipment: ["pullup_bar"], aliases: ["pullup", "pull up"] },
  { name: "Chin-Up", pattern: "vertical_pull", muscles: ["back", "biceps"], loadType: "bodyweight", equipment: ["pullup_bar"], aliases: ["chinup", "chin up", "chins"] },
  {
    name: "Lat Pulldown",
    pattern: "vertical_pull",
    muscles: ["back", "biceps"],
    loadType: "external",
    equipment: ["cable"],
    aliases: ["pulldown", "lat pull down"],
    variantKey: "cable_lat_bar",
    variantAttributes: { machine: "cable", attachment: "lat_bar" },
    exactExecutionRequirement: {
      requiredProfileKind: "cable_machine",
      requiredAttachmentKind: "lat_bar",
      requiresKnownGeometry: true,
      reviewNotes:
        "Reviewed cable lat-pulldown variant: exact cable geometry and an explicitly compatible lat bar are required.",
    },
  },
  {
    name: "Plate-Loaded Lat Pulldown",
    pattern: "vertical_pull",
    muscles: ["back", "biceps"],
    loadType: "external",
    equipment: ["machine"],
    aliases: ["plate loaded pulldown"],
    family: "Lat Pulldown",
    variantKey: "plate_loaded_machine",
    variantAttributes: { machine: "plate_loaded" },
    exactExecutionRequirement: {
      requiredProfileKind: "plate_loaded_machine",
      requiresKnownGeometry: true,
      reviewNotes:
        "Reviewed plate-loaded lat-pulldown variant: exact machine geometry is required; selectorized machines do not satisfy it.",
    },
  },
  { name: "Band Lat Pulldown", pattern: "vertical_pull", muscles: ["back", "biceps"], loadType: "band", equipment: ["bands"], aliases: ["band pulldown"] },
  { name: "Band Straight-Arm Pulldown", pattern: "vertical_pull", muscles: ["back", "lats"], loadType: "band", equipment: ["bands"], aliases: ["band straight arm pulldown"] },

  // --- Lunge ---
  { name: "Dumbbell Walking Lunge", pattern: "lunge", muscles: ["quads", "glutes"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["walking lunge"], unilateral: true },
  { name: "Dumbbell Reverse Lunge", pattern: "lunge", muscles: ["quads", "glutes"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["reverse lunge", "db reverse lunge"], unilateral: true },
  { name: "Split Squat", pattern: "lunge", muscles: ["quads", "glutes"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["db split squat"], unilateral: true },
  { name: "Bulgarian Split Squat", pattern: "lunge", muscles: ["quads", "glutes"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], aliases: ["bss", "rear foot elevated split squat", "rfess"], unilateral: true },
  {
    name: "Bodyweight Bulgarian Split Squat",
    family: "Bulgarian Split Squat",
    pattern: "lunge",
    muscles: ["quads", "glutes"],
    loadType: "bodyweight",
    equipment: ["bodyweight", "bench"],
    aliases: [
      "bodyweight bss",
      "bodyweight rear foot elevated split squat",
      "bulgarian split squat bodyweight",
    ],
    unilateral: true,
    metricType: "reps",
    loadSemantics: "bodyweight",
    variantKey: "bodyweight",
    variantAttributes: {
      laterality: "unilateral",
      assistance: "none",
    },
    source: {
      name: "Workout Tracker curated catalog",
      id: "bodyweight_bulgarian_split_squat",
      license: "Project-authored metadata",
    },
  },
  { name: "Dumbbell Step-Up", pattern: "lunge", muscles: ["quads", "glutes"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], aliases: ["step up", "step-up"], unilateral: true },
  { name: "Lateral Lunge", pattern: "lunge", muscles: ["quads", "glutes", "adductors"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["side lunge"], unilateral: true },

  // --- Carry ---
  { name: "Farmer Carry", pattern: "carry", muscles: ["grip", "traps", "core"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["farmers walk", "farmer's carry", "farmers carry"] },
  { name: "Suitcase Carry", pattern: "carry", muscles: ["core", "grip"], loadType: "dumbbell", equipment: ["dumbbell"], unilateral: true },
  { name: "Kettlebell Rack Carry", pattern: "carry", muscles: ["core", "shoulders"], loadType: "kettlebell", equipment: ["kettlebell"], aliases: ["kb rack carry"], unilateral: true },

  // --- Core ---
  { name: "Plank", pattern: "core", muscles: ["core"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["front plank"] },
  { name: "Side Plank", pattern: "core", muscles: ["core", "obliques"], loadType: "bodyweight", equipment: ["bodyweight"], unilateral: true },
  { name: "Dead Bug", pattern: "core", muscles: ["core"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["deadbug"] },
  { name: "Bird Dog", pattern: "core", muscles: ["core", "back"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["birddog"] },
  { name: "Hanging Knee Raise", pattern: "core", muscles: ["core", "hip flexors"], loadType: "bodyweight", equipment: ["pullup_bar"], aliases: ["knee raise"] },
  { name: "Pallof Press", pattern: "core", muscles: ["core", "obliques"], loadType: "band", equipment: ["bands"], aliases: ["band pallof press"] },
  { name: "Kettlebell Windmill", pattern: "core", muscles: ["core", "shoulders"], loadType: "kettlebell", equipment: ["kettlebell"], aliases: ["kb windmill"], unilateral: true },
  { name: "Cable Crunch", pattern: "core", muscles: ["abs"], loadType: "external", equipment: ["cable"] },
  { name: "Hollow Hold", pattern: "core", muscles: ["core"], loadType: "bodyweight", equipment: ["bodyweight"] },

  // --- Isolation: arms ---
  { name: "EZ-Bar Curl", pattern: "isolation_arms", muscles: ["biceps"], loadType: "ez_bar", equipment: ["ez_bar", "plates"], aliases: ["ez bar biceps curl", "ez curl"] },
  { name: "Dumbbell Curl", pattern: "isolation_arms", muscles: ["biceps"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["dumbbell bicep curl", "db curl"] },
  { name: "Hammer Curl", pattern: "isolation_arms", muscles: ["biceps", "forearms"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["db hammer curl"] },
  { name: "Incline Dumbbell Curl", pattern: "isolation_arms", muscles: ["biceps"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], aliases: ["incline curl"] },
  { name: "Concentration Curl", pattern: "isolation_arms", muscles: ["biceps"], loadType: "dumbbell", equipment: ["dumbbell", "bench"], unilateral: true },
  { name: "Band Curl", pattern: "isolation_arms", muscles: ["biceps"], loadType: "band", equipment: ["bands"] },
  { name: "Cable Curl", pattern: "isolation_arms", muscles: ["biceps"], loadType: "external", equipment: ["cable"] },
  { name: "Preacher Curl", pattern: "isolation_arms", muscles: ["biceps"], loadType: "external", equipment: ["machine"] },
  { name: "EZ-Bar Skull Crusher", pattern: "isolation_arms", muscles: ["triceps"], loadType: "ez_bar", equipment: ["ez_bar", "plates", "bench"], aliases: ["ez bar skull crusher", "ez bar skullcrusher"] },
  { name: "Dumbbell Overhead Triceps Extension", pattern: "isolation_arms", muscles: ["triceps"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["overhead triceps extension", "db triceps extension", "french press"] },
  { name: "Band Triceps Pushdown", pattern: "isolation_arms", muscles: ["triceps"], loadType: "band", equipment: ["bands"], aliases: ["band pushdown"] },
  { name: "Triceps Pushdown", pattern: "isolation_arms", muscles: ["triceps"], loadType: "external", equipment: ["cable"], aliases: ["cable pushdown", "rope pushdown"] },
  { name: "Close-Grip Bench Press", pattern: "isolation_arms", muscles: ["triceps", "chest"], loadType: "barbell", equipment: ["barbell", "plates", "bench", "rack"], aliases: ["cgbp", "close grip bench"] },
  { name: "Diamond Push-Up", pattern: "isolation_arms", muscles: ["triceps", "chest"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["diamond pushup"] },

  // --- Isolation: shoulders ---
  { name: "Dumbbell Lateral Raise", pattern: "isolation_shoulders", muscles: ["shoulders"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["lateral raise", "side raise", "db lateral raise"] },
  { name: "Band Lateral Raise", pattern: "isolation_shoulders", muscles: ["shoulders"], loadType: "band", equipment: ["bands"] },
  { name: "Dumbbell Front Raise", pattern: "isolation_shoulders", muscles: ["shoulders"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["front raise"] },
  { name: "Dumbbell Rear Delt Fly", pattern: "isolation_shoulders", muscles: ["rear delts"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["rear delt fly", "reverse fly", "bent over fly"] },
  { name: "Band Pull-Apart", pattern: "isolation_shoulders", muscles: ["rear delts", "upper back"], loadType: "band", equipment: ["bands"], aliases: ["band pull apart", "pull-aparts"] },
  { name: "Band Face Pull", pattern: "isolation_shoulders", muscles: ["rear delts", "upper back"], loadType: "band", equipment: ["bands"], aliases: ["face pull"] },
  { name: "Cable Face Pull", pattern: "isolation_shoulders", muscles: ["rear delts", "upper back"], loadType: "external", equipment: ["cable"] },
  { name: "Dumbbell Shrug", pattern: "isolation_shoulders", muscles: ["traps"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["db shrug", "shrug"] },
  { name: "Barbell Shrug", pattern: "isolation_shoulders", muscles: ["traps"], loadType: "barbell", equipment: ["barbell", "plates"] },

  // --- Isolation: legs ---
  { name: "Leg Extension", pattern: "isolation_legs", muscles: ["quads"], loadType: "external", equipment: ["machine"] },
  { name: "Leg Curl", pattern: "isolation_legs", muscles: ["hamstrings"], loadType: "external", equipment: ["machine"], aliases: ["hamstring curl"] },
  { name: "Standing Calf Raise", pattern: "isolation_legs", muscles: ["calves"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["calf raise"] },
  { name: "Dumbbell Calf Raise", pattern: "isolation_legs", muscles: ["calves"], loadType: "dumbbell", equipment: ["dumbbell"], aliases: ["db calf raise", "standing dumbbell calf raise", "standing calf raise (dumbbell)"] },

  // --- Conditioning ---
  { name: "Jump Rope", pattern: "conditioning", muscles: ["calves", "cardio"], loadType: "bodyweight", equipment: ["jump_rope"], aliases: ["skipping", "skipping rope", "skip rope"] },
  { name: "Elliptical", pattern: "conditioning", muscles: ["cardio"], loadType: "bodyweight", equipment: ["elliptical"], aliases: ["elliptical trainer", "cross trainer"] },
  { name: "Rowing Machine", pattern: "conditioning", muscles: ["cardio", "back"], loadType: "external", equipment: ["machine"], aliases: ["erg", "row erg"] },
  { name: "Burpee", pattern: "conditioning", muscles: ["cardio", "full body"], loadType: "bodyweight", equipment: ["bodyweight"], aliases: ["burpees"] },
];

export const exerciseLibrary: SeedExercise[] = [
  ...baseExerciseLibrary,
  ...expandedExerciseLibrary,
];
