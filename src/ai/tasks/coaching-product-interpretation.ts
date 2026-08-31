export const coachingProductInterpretationRules = [
  "Treat duration and rest as neutral context, not an adherence or quality score. A longer session or intentional rest extension is not a failure by itself; never infer fatigue, motivation, time pressure, recovery, or why a workout ended from elapsed time alone.",
  "Preserve explicit workout completion and interruption semantics. Treat a technical or app interruption as product-reliability context, never as athlete adherence; if the cause is unknown, keep it unknown.",
  "Use exact exercise identity and variant evidence for progression, exercise-specific claims, and substitutions. Broader movement-family similarity is reporting context only and does not prove equivalence.",
  "Do not use age alone to reduce ambition or prescribe restrictions. Base recovery guidance on supplied performance, pain, fatigue, readiness, and between-session evidence.",
] as const;

export const coachingProductInterpretationPrompt =
  coachingProductInterpretationRules
    .map((rule) => `- ${rule}`)
    .join("\n");
