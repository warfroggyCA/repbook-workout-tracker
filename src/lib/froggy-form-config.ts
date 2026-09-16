import { FROGGY_CURL_CUES, FROGGY_CURL_MEDIA, type FroggyDemoKey } from "./froggy-form-demo";

export type FroggyMode = "pulse" | "steady" | "clean";
export type FroggyCallout = { id: string; text: [string, string]; x: number; y: number; edge: "left" | "right"; offsetX?: number };
export type FroggyFormConfig = {
  title: string; setup: string; media: string; thumbnail: string; thumbnailClass: string;
  animatedThumbnail?: string;
  modes: FroggyMode[]; cues: readonly { kind: "DO" | "AVOID"; text: string }[];
  muscles: string; reference: string; referenceLabel: string;
  offsetY?: number; floatingCue?: boolean;
  videoHeight: number; scale: number; callouts: FroggyCallout[];
};
const thumb = "absolute left-0 top-0 h-auto w-full max-w-none";
const base = { videoHeight: 972, scale: 1, thumbnail: "thumbnail.png", thumbnailClass: thumb };

export const FROGGY_FORMS: Record<FroggyDemoKey, FroggyFormConfig> = {
  "seated-overhead-triceps-extension-v155": {
    ...base,
    title: "Seated overhead triceps extension",
    setup: "Seated · one fixed dumbbell · both hands",
    media: "/exercise-media/froggy/seated-overhead-triceps-extension-v155",
    animatedThumbnail: "/exercise-media/froggy/seated-overhead-triceps-extension-v155/thumbnail-sprite.webp",
    modes: ["pulse", "steady", "clean"],
    cues: [
      { kind: "DO", text: "Keep your upper arms steady." },
      { kind: "AVOID", text: "Arching your back to lift." },
    ],
    muscles: "Target: triceps (red)",
    reference: "https://www.acefitness.org/resources/everyone/exercise-library/74/triceps-extension/",
    referenceLabel: "ACE · overhead triceps extension (standing example)",
    floatingCue: true, offsetY: .025, videoHeight: 1080, scale: 1,
    callouts: [
      { id: "upper-arm", text: ["Upper arms", "steady"], x: 42, y: 400, edge: "right" },
      { id: "forearm", text: ["Lower with", "control"], x: 746, y: 264, edge: "left" },
    ],
  },
  "incline-dumbbell-curl-v102": {
    title: "Incline Dumbbell Curl", setup: "60° bench · palms-up grip · both arms",
    media: FROGGY_CURL_MEDIA, thumbnail: "thumbnail-103.png",
    animatedThumbnail: "/exercise-media/froggy/animated-icons-v110/incline-curl.webp",
    thumbnailClass: "absolute -left-[6%] top-0 h-auto w-[112%] max-w-none",
    modes: ["pulse", "steady", "clean"], cues: FROGGY_CURL_CUES,
    muscles: "Target: biceps (red) · Assist: forearm flexors (purple)",
    reference: "https://www.muscleandstrength.com/exercises/incline-dumbbell-curl.html",
    referenceLabel: "Muscle & Strength · incline dumbbell curl",
    videoHeight: 1080, scale: 1.1,
    callouts: [
      { id: "upper-arm", text: ["Upper arms", "steady"], x: 720, y: 320, edge: "left", offsetX: 22 },
      { id: "forearm", text: ["Controlled", "lowering"], x: 720, y: 600, edge: "left", offsetX: 12 },
    ],
  },
  "incline-press-v107": {
    ...base, title: "Incline Barbell Bench Press", setup: "30° bench · closed overhand grip · both arms",
    media: "/exercise-media/froggy/incline-press-v107", modes: ["steady"],
    cues: [
      { kind: "DO", text: "Lower toward your upper chest." },
      { kind: "DO", text: "Keep your back supported." },
      { kind: "AVOID", text: "Rushing the lowering phase." },
    ],
    muscles: "Target: upper chest (red) · Assist: triceps and front shoulders (blue)",
    reference: "https://www.nasm.org/resource-center/exercise-library/incline-barbell-bench-press",
    referenceLabel: "NASM · incline barbell bench press (45° example; this demo uses 30°)",
    callouts: [
      { id: "wrist", text: ["Controlled", "lowering"], x: 36, y: 245, edge: "right" },
      { id: "foot", text: ["Feet stay", "planted"], x: 735, y: 850, edge: "left" },
    ],
  },
  "lat-pulldown-v107": {
    ...base, title: "Wide-Grip Lat Pulldown", setup: "Wide overhand grip · angled bar ends · rear view",
    thumbnailClass: "absolute -left-[6%] -top-[48%] h-auto w-[112%] max-w-none",
    media: "/exercise-media/froggy/lat-pulldown-v107", modes: ["steady", "clean"],
    cues: [
      { kind: "DO", text: "Pull toward your upper chest." },
      { kind: "DO", text: "Control the return overhead." },
      { kind: "AVOID", text: "Swinging your torso to pull." },
    ],
    muscles: "Target: lats (red) · Assist: biceps, rear shoulders and upper back (blue)",
    reference: "https://www.nasm.org/resource-center/blog/training/the-biomechanics-of-the-lat-pulldown-muscles-grip-and-form",
    referenceLabel: "NASM · lat pulldown grip and form",
    callouts: [
      { id: "elbow", text: ["Elbows", "drive down"], x: 36, y: 355, edge: "right" },
      { id: "torso", text: ["Torso stays", "steady"], x: 750, y: 665, edge: "left" },
    ],
  },
  "goblet-squat-v107": {
    ...base, title: "Kettlebell Goblet Squat", setup: "Cupped kettlebell · two-hand hold",
    animatedThumbnail: "/exercise-media/froggy/animated-icons-v110/goblet-squat.webp",
    media: "/exercise-media/froggy/goblet-squat-v107", modes: ["steady", "clean"],
    cues: [
      { kind: "DO", text: "Keep the weight at your chest." },
      { kind: "DO", text: "Squat as low as control allows." },
      { kind: "AVOID", text: "Letting your knees collapse in." },
    ],
    muscles: "Target: quads and glutes (red) · Assist: hamstrings (blue); trunk and hips also stabilize",
    reference: "https://www.nasm.org/resource-center/exercise-library/goblet-squat",
    referenceLabel: "NASM · goblet squat",
    callouts: [
      { id: "bell", text: ["Weight", "stays close"], x: 36, y: 320, edge: "right" },
      { id: "knee", text: ["Knees track", "with toes"], x: 750, y: 755, edge: "left" },
    ],
  },
  "romanian-deadlift-v107": {
    ...base, title: "Romanian Deadlift", setup: "Barbell hip hinge · soft knees · rear three-quarter view",
    media: "/exercise-media/froggy/romanian-deadlift-v107", modes: ["pulse", "steady", "clean"],
    cues: [
      { kind: "DO", text: "Hinge at your hips; brace." },
      { kind: "DO", text: "Keep the bar close to your legs." },
      { kind: "AVOID", text: "Rounding to reach lower." },
    ],
    muscles: "Target: hamstrings and glutes (red) · Support: spinal erectors (purple/blue)",
    reference: "https://www.catalystathletics.com/exercise/101/Romanian-Deadlift-RDL/",
    referenceLabel: "Catalyst Athletics · Romanian deadlift",
    callouts: [
      { id: "hip", text: ["Hinge at", "the hips"], x: 750, y: 280, edge: "left" },
      { id: "bar", text: ["Bar stays", "close"], x: 36, y: 650, edge: "right" },
    ],
  },
  "barbell-bench-v108": {
    ...base, title: "Barbell Bench Press", setup: "Flat bench · closed overhand grip · both arms",
    media: "/exercise-media/froggy/barbell-bench-v108", modes: ["steady", "clean"],
    cues: [
      { kind: "DO", text: "Lower with control toward your chest." },
      { kind: "DO", text: "Keep your feet firmly planted." },
      { kind: "AVOID", text: "Rushing the lowering phase." },
    ],
    muscles: "Target: chest (red) · Assist: triceps and front shoulders (blue)",
    reference: "https://www.nasm.org/resource-center/exercise-library/barbell-bench-press",
    referenceLabel: "NASM · barbell bench press",
    callouts: [
      { id: "wrist", text: ["Controlled", "lowering"], x: 36, y: 270, edge: "right" },
      { id: "foot", text: ["Feet stay", "planted"], x: 750, y: 775, edge: "left" },
    ],
  },
  "back-squat-v108": {
    ...base, videoHeight: 1080, title: "Barbell Back Squat", setup: "High bar on upper traps · whole-foot balance",
    media: "/exercise-media/froggy/back-squat-v108", modes: ["pulse", "steady", "clean"],
    cues: [
      { kind: "DO", text: "Brace before you descend." },
      { kind: "DO", text: "Go as low as control allows." },
      { kind: "AVOID", text: "Letting your knees collapse in." },
    ],
    muscles: "Target: quads and glutes (red) · Assist: hamstrings (purple/blue); trunk also stabilizes",
    reference: "https://www.catalystathletics.com/exercise/77/Back-Squat/",
    referenceLabel: "Catalyst Athletics · high-bar back squat",
    callouts: [
      { id: "trunk", text: ["Trunk stays", "braced"], x: 36, y: 635, edge: "right" },
      { id: "knee", text: ["Knees track", "with toes"], x: 750, y: 830, edge: "left" },
    ],
  },
  "overhead-press-v108": {
    ...base, title: "Barbell Overhead Press", setup: "Standing strict press · closed overhand grip",
    media: "/exercise-media/froggy/overhead-press-v108", modes: ["pulse", "steady", "clean"],
    cues: [
      { kind: "DO", text: "Move your head clear of the bar." },
      { kind: "DO", text: "Finish with the bar overhead." },
      { kind: "AVOID", text: "Leaning far back to press." },
    ],
    muscles: "Target: front and side shoulders (red) · Assist: triceps (purple/blue)",
    reference: "https://www.catalystathletics.com/exercise/90/Press/",
    referenceLabel: "Catalyst Athletics · strict press",
    callouts: [
      { id: "bar", text: ["Bar finishes", "overhead"], x: 750, y: 540, edge: "left" },
      { id: "trunk", text: ["Trunk stays", "braced"], x: 36, y: 630, edge: "right" },
    ],
  },
  "barbell-row-v108": {
    ...base, title: "Barbell Row", setup: "Overhand grip · stable hip hinge · rear three-quarter view",
    media: "/exercise-media/froggy/barbell-row-v108", modes: ["pulse", "steady", "clean"],
    cues: [
      { kind: "DO", text: "Row toward your upper abdomen." },
      { kind: "DO", text: "Control the return to straight arms." },
      { kind: "AVOID", text: "Heaving your torso to lift." },
    ],
    muscles: "Target: lats and upper/mid-back (red) · Assist: biceps and rear shoulders (purple/blue)",
    reference: "https://www.catalystathletics.com/exercise/171/Bent-Row/",
    referenceLabel: "Catalyst Athletics · bent row (this demo uses a strict torso)",
    callouts: [
      { id: "hip", text: ["Hold your", "hip hinge"], x: 750, y: 280, edge: "left" },
      { id: "bar", text: ["Controlled", "return"], x: 36, y: 800, edge: "right" },
    ],
  },
  "bulgarian-split-squat-v109": {
    ...base, videoHeight: 1080, title: "Bulgarian Split Squat",
    setup: "Dumbbells at sides · left leg shown · repeat both sides",
    media: "/exercise-media/froggy/bulgarian-split-squat-v109", modes: ["pulse", "steady", "clean"],
    cues: [
      { kind: "DO", text: "Push through your whole front foot." },
      { kind: "DO", text: "Complete your reps on each side." },
      { kind: "AVOID", text: "Dropping into the bottom." },
    ],
    muscles: "Target: front-leg quads and glute (red) · Assist: hamstrings (purple/blue)",
    reference: "https://www.catalystathletics.com/exercise/173/Bulgarian-Split-Squat/",
    referenceLabel: "Catalyst Athletics · Bulgarian split squat (this demo stops above the floor)",
    callouts: [
      { id: "front-knee", text: ["Knee tracks", "with toes"], x: 30, y: 490, edge: "right" },
      { id: "front-foot", text: ["Front foot", "stays planted"], x: 30, y: 815, edge: "right" },
    ],
  },
  "ez-bar-curl-v109": {
    ...base, videoHeight: 1080, title: "EZ-Bar Curl", setup: "Standing · angled underhand grip · both arms",
    media: "/exercise-media/froggy/ez-bar-curl-v109", modes: ["pulse", "steady", "clean"],
    cues: [
      { kind: "DO", text: "Keep your elbows beside your ribs." },
      { kind: "DO", text: "Lower the bar under control." },
      { kind: "AVOID", text: "Leaning back to swing the bar." },
    ],
    muscles: "Target: biceps (red) · Assist: forearm flexors (purple)",
    reference: "https://www.muscleandstrength.com/exercises/ez-bar-curl.html",
    referenceLabel: "Muscle & Strength · EZ-bar curl",
    callouts: [
      { id: "upper-arm", text: ["Upper arms", "stay steady"], x: 750, y: 450, edge: "left" },
      { id: "forearm", text: ["Controlled", "lowering"], x: 30, y: 610, edge: "right" },
    ],
  },
  "standing-cable-leg-curl-v117": {
    ...base,
    thumbnailClass: "absolute left-0 -top-[68%] h-auto w-full max-w-none",
    "title": "Standing Cable Leg Curl",
    "setup": "Low pulley · ankle cuff · left leg shown; repeat each side",
    "muscles": "Target: hamstrings (red) · Assist: calf (blue); shorts highlights are schematic",
    "reference": "https://exrx.net/WeightExercises/Hamstrings/CBStandingLegCurl",
    "referenceLabel": "ExRx · standing cable leg curl",
    "media": "/exercise-media/froggy/standing-cable-leg-curl-v117",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Keep hips steady; return slowly."
        },
        {
            "kind": "AVOID",
            "text": "Swinging the working thigh."
        }
    ],
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.04,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Hips stay",
                "still"
            ],
            "x": 759,
            "y": 380,
            "edge": "left"
        },
        {
            "id": "tip-2",
            "text": [
                "Return",
                "slowly"
            ],
            "x": 42,
            "y": 688,
            "edge": "right"
        }
    ]
  },
  "rope-pushdown-v117": {
    ...base,
    thumbnailClass: "absolute -left-[60%] -top-[65%] h-auto w-[150%] max-w-none",
    "title": "Rope Triceps Pushdown",
    "setup": "Rope attachment · high pulley · neutral grip",
    "muscles": "Target: triceps (red) · Grip support: forearms (blue)",
    "reference": "https://www.strengthlog.com/tricep-pushdown-with-rope/",
    "referenceLabel": "StrengthLog · rope triceps pushdown",
    "media": "/exercise-media/froggy/rope-pushdown-v117",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Extend elbows with control."
        },
        {
            "kind": "AVOID",
            "text": "Using body momentum."
        }
    ],
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.04,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Upper arms",
                "stay still"
            ],
            "x": 755,
            "y": 369,
            "edge": "left"
        },
        {
            "id": "tip-2",
            "text": [
                "Wrists stay",
                "straight"
            ],
            "x": 38,
            "y": 696,
            "edge": "right"
        }
    ]
  },
  "chest-supported-row-v117": {
    ...base,
    "title": "Chest-Supported Dumbbell Row",
    "setup": "30° bench · chest supported · palms facing inward",
    "muscles": "Target: lats and upper back (red) · Assist: biceps and rear shoulders (blue)",
    "reference": "https://www.muscleandfitness.com/exercise/workouts/back-exercises/thirty-degree-incline-dumbbell-row/",
    "referenceLabel": "Muscle & Fitness · 30-degree incline dumbbell row",
    "media": "/exercise-media/froggy/chest-supported-row-v117",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Keep the chest on the pad."
        },
        {
            "kind": "AVOID",
            "text": "Jerking the weights upward."
        }
    ],
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.04,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Torso stays",
                "supported"
            ],
            "x": 755,
            "y": 228,
            "edge": "left"
        },
        {
            "id": "tip-2",
            "text": [
                "Pull elbows",
                "back"
            ],
            "x": 742,
            "y": 622,
            "edge": "left"
        }
    ]
  },
  "chest-supported-reverse-fly-v117": {
    ...base,
    "title": "Chest-Supported Dumbbell Reverse Fly",
    "setup": "30° bench · chest supported · soft elbow bend",
    "muscles": "Target: rear shoulders (red) · Assist: upper back (blue)",
    "reference": "https://www.muscleandstrength.com/exercises/dumbbell-reverse-fly-on-incline-bench.html",
    "referenceLabel": "Muscle & Strength · reverse fly on incline bench",
    "media": "/exercise-media/froggy/chest-supported-reverse-fly-v117",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Lift out to the sides with control."
        },
        {
            "kind": "AVOID",
            "text": "Shrugging or swinging."
        }
    ],
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.04,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Soft elbow",
                "bend"
            ],
            "x": 38,
            "y": 671,
            "edge": "right"
        },
        {
            "id": "tip-2",
            "text": [
                "Chest stays",
                "supported"
            ],
            "x": 755,
            "y": 664,
            "edge": "left"
        }
    ]
  },
  "single-leg-dumbbell-calf-raise-v133": {
    ...base,
    thumbnailClass: "absolute left-0 bottom-0 h-auto w-full max-w-none",
    "title": "Single-leg dumbbell calf raise",
    "setup": "Forefoot on a weight plate; light support for balance. Left leg shown.",
    "media": "/exercise-media/froggy/single-leg-dumbbell-calf-raise-v133",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Rise through the ball of your foot."
        },
        {
            "kind": "AVOID",
            "text": "Bouncing or bending the knee."
        }
    ],
    "muscles": "Target: working calf (red)",
    "reference": "https://www.muscleandfitness.com/exercise/workouts/leg-exercises/single-leg-standing-dumbbell-calf-raise/",
    "referenceLabel": "Muscle & Fitness · single-leg calf raise",
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.08,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Working knee",
                "stays steady"
            ],
            "x": 42,
            "y": 475,
            "edge": "right"
        },
        {
            "id": "tip-2",
            "text": [
                "Lift the heel",
                "with control"
            ],
            "x": 747,
            "y": 728,
            "edge": "left"
        }
    ]
  },
  "dead-bug-v133": {
    ...base,
    thumbnailClass: "absolute -left-[25%] top-0 h-auto w-[150%] max-w-none",
    "title": "Dead bug",
    "setup": "Alternate opposite arm and leg; keep the trunk steady and breathe.",
    "media": "/exercise-media/froggy/dead-bug-v133",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Reach with opposite arm and leg."
        },
        {
            "kind": "AVOID",
            "text": "Arching your lower back."
        }
    ],
    "muscles": "Target: abdominal wall and obliques (red)",
    "reference": "https://www.health.harvard.edu/exercise-and-fitness/the-many-benefits-of-the-dead-bug",
    "referenceLabel": "Harvard Health · dead bug",
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.04,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Opposite arm",
                "and leg"
            ],
            "x": 42,
            "y": 270,
            "edge": "right"
        },
        {
            "id": "tip-2",
            "text": [
                "Trunk stays",
                "steady"
            ],
            "x": 738,
            "y": 738,
            "edge": "left"
        }
    ]
  },
  "zottman-curl-v133": {
    ...base,
    thumbnailClass: "absolute left-0 -top-[35%] h-auto w-full max-w-none",
    "title": "Zottman curl",
    "setup": "Palms up to lift. Rotate at the top, then lower with palms down.",
    "media": "/exercise-media/froggy/zottman-curl-v133",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Turn palms down before lowering."
        },
        {
            "kind": "AVOID",
            "text": "Swinging the upper arms."
        }
    ],
    "muscles": "Target: biceps (red) · Support: forearms (blue)",
    "reference": "https://www.muscleandstrength.com/exercises/zottman-curl.html",
    "referenceLabel": "Muscle & Strength · Zottman curl",
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.04,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Upper arms",
                "stay quiet"
            ],
            "x": 747,
            "y": 390,
            "edge": "left"
        },
        {
            "id": "tip-2",
            "text": [
                "Turn through",
                "the forearms"
            ],
            "x": 42,
            "y": 648,
            "edge": "right"
        }
    ]
  },
  "kettlebell-suitcase-carry-v133": {
    ...base,
    thumbnailClass: "absolute left-0 -top-[110%] h-auto w-full max-w-none",
    "title": "Kettlebell suitcase carry",
    "setup": "Carry on one side with controlled steps. Repeat with the other hand.",
    "media": "/exercise-media/froggy/kettlebell-suitcase-carry-v133",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Walk tall with steady steps."
        },
        {
            "kind": "AVOID",
            "text": "Leaning toward the weight."
        }
    ],
    "muscles": "Target: core stabilization (red) · Support: forearm grip support (blue)",
    "reference": "https://www.acefitness.org/continuing-education/certified/october-2022/8147/kettlebells-kick-butt-in-more-ways-than-one/",
    "referenceLabel": "ACE · kettlebell suitcase carry",
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.04,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Shoulders",
                "stay level"
            ],
            "x": 42,
            "y": 375,
            "edge": "right"
        },
        {
            "id": "tip-2",
            "text": [
                "Hold the bell",
                "beside the hip"
            ],
            "x": 747,
            "y": 664,
            "edge": "left"
        }
    ]
  },
  "standing-dumbbell-lateral-raise-v138": {
    ...base,
    "title": "Standing dumbbell lateral raise",
    "setup": "Stand upright; raise out to the sides with a small elbow bend.",
    "media": "/exercise-media/froggy/standing-dumbbell-lateral-raise-v138",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Lift smoothly to shoulder height."
        },
        {
            "kind": "AVOID",
            "text": "Swinging your torso to lift."
        }
    ],
    "muscles": "Target: shoulders — lateral deltoid emphasis (red) · Support: upper trapezius assistance (blue)",
    "reference": "https://www.acefitness.org/resources/everyone/exercise-library/26/lateral-raise/",
    "referenceLabel": "ACE · lateral raise",
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.06,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Soft elbow",
                "bend"
            ],
            "x": 42,
            "y": 612,
            "edge": "right"
        },
        {
            "id": "tip-2",
            "text": [
                "Keep wrists",
                "neutral"
            ],
            "x": 747,
            "y": 675,
            "edge": "left"
        }
    ],
    "thumbnailClass": "absolute left-0 top-0 h-auto w-full max-w-none"
  },
  "flat-dumbbell-bench-press-v138": {
    ...base,
    "title": "Flat dumbbell bench press",
    "setup": "Flat bench; controlled lowering beside the chest, then press up and inward.",
    "media": "/exercise-media/froggy/flat-dumbbell-bench-press-v138",
    "modes": [
        "pulse",
        "steady",
        "clean"
    ],
    "cues": [
        {
            "kind": "DO",
            "text": "Lower with control beside your chest."
        },
        {
            "kind": "AVOID",
            "text": "Banging the weights together."
        }
    ],
    "muscles": "Target: pectorals (red) · Support: triceps and front deltoids (blue)",
    "reference": "https://www.muscleandstrength.com/exercises/dumbbell-bench-press.html",
    "referenceLabel": "Muscle & Strength · dumbbell bench press",
    "videoHeight": 1080,
    "scale": 1,
    "offsetY": 0.06,
    "floatingCue": true,
    "callouts": [
        {
            "id": "tip-1",
            "text": [
                "Wrists over",
                "elbows"
            ],
            "x": 42,
            "y": 243,
            "edge": "right"
        },
        {
            "id": "tip-2",
            "text": [
                "Feet stay",
                "planted"
            ],
            "x": 747,
            "y": 791,
            "edge": "left"
        }
    ],
    "thumbnailClass": "absolute -left-[8%] top-0 h-auto w-[116%] max-w-none"
  },
};
