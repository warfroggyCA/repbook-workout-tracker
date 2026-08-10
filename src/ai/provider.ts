import {
  generateText,
  NoOutputGeneratedError,
  Output,
  streamText,
  type DeepPartial,
  type LanguageModel,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { z } from "zod";
import { optionalEnv } from "@/lib/env";
import { isDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";
import { logDiagnosticEvent } from "@/lib/server-log";
import { sanitizeAIFinishReason } from "@/lib/ai-provider-error";
import { buildBaRoutineChangeFixture } from "@/ai/acceptance-routine-change-fixture";
import {
  BaRoutineBuildUnavailableError,
  createBaRoutineBuildFailure,
  parseBaRoutineFailureMode,
} from "@/ai/acceptance-routine-failure-fixture";

/**
 * Provider abstraction (plan §9). Prompts, schemas, and model choice live in
 * src/ai/tasks/*; nothing provider-specific leaks into business logic. All
 * calls are server-side only — the API key never reaches the browser.
 */

export type AITask =
  | "equipment_parse"
  | "constraint_parse"
  | "routine_parse"
  | "routine_build"
  | "exercise_map"
  | "log_parse"
  | "weekly_review"
  | "substitution"
  | "coaching_qa"
  | "live_coaching";

export type AIResult<T> = {
  value: T;
  model: string;
  latencyMs: number;
  rawText: string | null;
  usage: AIUsage;
};

export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AIStreamResult<T> = {
  partials: AsyncIterable<DeepPartial<T>>;
  value: Promise<T>;
  model: string;
  usage: Promise<AIUsage>;
};

export const OPENAI_NO_STORAGE_OPTIONS = {
  openai: {
    store: false,
    reasoningEffort: "low",
    reasoningSummary: null,
  },
} as const;

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

export function structuredOutputTokenLimit(task: AITask): number {
  if (task === "routine_build") return 6_000;
  if (task === "weekly_review" || task === "coaching_qa") return 4_000;
  return 2_000;
}

export interface AIProvider {
  parseStructured<T>(opts: {
    task: AITask;
    system: string;
    input: string;
    schema: z.ZodType<T>;
    abortSignal?: AbortSignal;
  }): Promise<AIResult<T>>;
  streamStructured<T>(opts: {
    task: AITask;
    system: string;
    input: string;
    schema: z.ZodType<T>;
    abortSignal?: AbortSignal;
  }): Promise<AIStreamResult<T>>;
}

/**
 * Provider selection (plan §9): whichever key is configured wins; Anthropic
 * takes precedence when both are set. AI_PARSE_MODEL overrides the default
 * parsing model for the active provider.
 */
function resolveModel(): {
  model: LanguageModel;
  name: string;
  providerOptions?: typeof OPENAI_NO_STORAGE_OPTIONS;
} | null {
  const anthropicKey = optionalEnv("ANTHROPIC_API_KEY");
  const openAIKey = optionalEnv("OPENAI_API_KEY");
  const configuredModel = optionalEnv("AI_PARSE_MODEL");

  if (anthropicKey) {
    const name = configuredModel ?? "claude-sonnet-5";
    const anthropic = createAnthropic({
      apiKey: anthropicKey,
    });
    return { model: anthropic(name), name };
  }
  if (openAIKey) {
    const name = configuredModel ?? DEFAULT_OPENAI_MODEL;
    const openai = createOpenAI({ apiKey: openAIKey });
    return {
      model: openai(name),
      name,
      providerOptions: OPENAI_NO_STORAGE_OPTIONS,
    };
  }
  return null;
}

/** Local canned responses for development or guarded disposable acceptance. */
function isFakeEnabled(): boolean {
  return (
    process.env.AI_FAKE === "1" &&
    (process.env.NODE_ENV === "development" || isDisposableAcceptanceRuntime())
  );
}

export function isAIAvailable(): boolean {
  return (
    !!optionalEnv("ANTHROPIC_API_KEY") ||
    !!optionalEnv("OPENAI_API_KEY") ||
    isFakeEnabled()
  );
}

export class AIUnavailableError extends Error {
  constructor() {
    super(
      "AI parsing is not configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY). Manual entry still works."
    );
    this.name = "AIUnavailableError";
  }
}

class SdkProvider implements AIProvider {
  async parseStructured<T>(opts: {
    task: AITask;
    system: string;
    input: string;
    schema: z.ZodType<T>;
    abortSignal?: AbortSignal;
  }): Promise<AIResult<T>> {
    const resolved = resolveModel();
    if (!resolved) throw new AIUnavailableError();
    const started = Date.now();
    const isRoutineBuild = opts.task === "routine_build";
    // No sampling params — defaults on both providers (Sonnet 5 rejects them).
    const result = await generateText({
      model: resolved.model,
      output: Output.object({ schema: opts.schema }),
      system: opts.system,
      prompt: opts.input,
      abortSignal: opts.abortSignal,
      maxOutputTokens: structuredOutputTokenLimit(opts.task),
      maxRetries: 1,
      timeout: {
        totalMs: isRoutineBuild ? 110_000 : 30_000,
        stepMs: isRoutineBuild ? 105_000 : 25_000,
      },
      providerOptions: resolved.providerOptions,
    });
    const usage = result.usage;
    let value: T;
    try {
      value = result.output;
    } catch (error) {
      if (NoOutputGeneratedError.isInstance(error)) {
        logDiagnosticEvent("ai.structured_output_missing", {
          finishReason: sanitizeAIFinishReason(result.finishReason),
        });
      }
      throw error;
    }
    return {
      value,
      model: resolved.name,
      latencyMs: Date.now() - started,
      rawText: JSON.stringify(value),
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens:
          usage.totalTokens ??
          (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      },
    };
  }

  async streamStructured<T>(opts: {
    task: AITask;
    system: string;
    input: string;
    schema: z.ZodType<T>;
    abortSignal?: AbortSignal;
  }): Promise<AIStreamResult<T>> {
    const resolved = resolveModel();
    if (!resolved) throw new AIUnavailableError();
    const result = streamText({
      model: resolved.model,
      output: Output.object({ schema: opts.schema }),
      system: opts.system,
      prompt: opts.input,
      abortSignal: opts.abortSignal,
      maxOutputTokens: 1_000,
      maxRetries: 1,
      timeout: { totalMs: 45_000, stepMs: 35_000, chunkMs: 10_000 },
      providerOptions: resolved.providerOptions,
    });
    return {
      partials: result.partialOutputStream,
      value: Promise.resolve(result.output),
      model: resolved.name,
      usage: Promise.resolve(result.usage).then((usage) => ({
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens:
          usage.totalTokens ??
          (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      })),
    };
  }
}

function fakeStreamDelayMs() {
  const parsed = Number.parseInt(process.env.AI_FAKE_STREAM_DELAY_MS ?? "25", 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 250)) : 25;
}

function abortError() {
  const error = new Error("The Live Coach stream was interrupted.");
  error.name = "AbortError";
  return error;
}

function fakeUsage(input: string, value: unknown): AIUsage {
  const inputTokens = Math.max(1, Math.ceil(input.length / 4));
  const outputTokens = Math.max(
    1,
    Math.ceil(JSON.stringify(value).length / 4)
  );
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

async function waitForFakeParse(signal?: AbortSignal) {
  const parsed = Number.parseInt(process.env.AI_FAKE_PARSE_DELAY_MS ?? "0", 10);
  const delay = Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 60_000)) : 0;
  if (signal?.aborted) throw abortError();
  if (delay === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true }
    );
  });
}

async function* fakeStructuredPartials<T>(
  task: AITask,
  value: T,
  abortSignal?: AbortSignal
): AsyncGenerator<DeepPartial<T>> {
  if (
    task !== "live_coaching" ||
    value == null ||
    typeof value !== "object" ||
    !("answer" in value) ||
    typeof value.answer !== "string"
  ) {
    if (abortSignal?.aborted) throw abortError();
    yield value as DeepPartial<T>;
    return;
  }

  const answer = value.answer;
  const step = Math.max(18, Math.ceil(answer.length / 8));
  for (let length = step; length < answer.length; length += step) {
    if (abortSignal?.aborted) throw abortError();
    await new Promise((resolve) => setTimeout(resolve, fakeStreamDelayMs()));
    yield { answer: answer.slice(0, length) } as DeepPartial<T>;
    if (process.env.AI_FAKE_STREAM_FAIL === "1" && length >= answer.length / 2) {
      throw new Error("The development Live Coach stream was interrupted.");
    }
  }
  if (abortSignal?.aborted) throw abortError();
  await new Promise((resolve) => setTimeout(resolve, fakeStreamDelayMs()));
  yield value as DeepPartial<T>;
}

/**
 * AI_FAKE=1 provider: returns a fixed ambiguous equipment parse so the
 * confirmation screen (amber fields) can be exercised locally. Never active
 * outside development, and only with the explicit env opt-in.
 */
class FakeProvider implements AIProvider {
  async streamStructured<T>(opts: {
    task: AITask;
    system: string;
    input: string;
    schema: z.ZodType<T>;
    abortSignal?: AbortSignal;
  }): Promise<AIStreamResult<T>> {
    const result = this.parseStructured(opts);
    return {
      partials: fakeStructuredPartials(
        opts.task,
        (await result).value,
        opts.abortSignal
      ),
      value: result.then(({ value }) => value),
      model: "fake-dev",
      usage: result.then(({ usage }) => usage),
    };
  }

  async parseStructured<T>(opts: {
    task: AITask;
    system: string;
    input: string;
    schema: z.ZodType<T>;
    abortSignal?: AbortSignal;
  }): Promise<AIResult<T>> {
    await waitForFakeParse(opts.abortSignal);
    if (opts.task === "weekly_review") {
      const context = JSON.parse(opts.input) as {
        sampleData?: {
          included?: boolean;
          sessionCount?: number;
          realSessionCount?: number;
        };
        trainingDigest?: {
          cadence?: {
            completedSessions?: number;
            averageSessionsPerCompleteWeek?: number | null;
            completeWeeks?: number;
            currentPreference?: { sessionsPerWeek?: number };
          };
          targetOutcomes?: { atOrAboveRate?: number | null };
          fatigue?: unknown[];
          pain?: Array<{ severity?: number; bodyPart?: string }>;
          dataGaps?: string[];
        };
      };
      const digest = context.trainingDigest;
      const sessionCount = digest?.cadence?.completedSessions ?? 0;
      const targetHitRate = digest?.targetOutcomes?.atOrAboveRate;
      const cadenceAverage = digest?.cadence?.averageSessionsPerCompleteWeek;
      const completeWeeks = digest?.cadence?.completeWeeks ?? 0;
      const currentPreference =
        digest?.cadence?.currentPreference?.sessionsPerWeek;
      const sampleCount = context.sampleData?.sessionCount ?? 0;
      const realCount = context.sampleData?.realSessionCount ?? 0;
      const fixture = {
        summary:
          sampleCount > 0
            ? `This is a demonstration review of ${sampleCount} labelled sample workouts${realCount > 0 ? ` alongside ${realCount} real workouts` : ""}. The pattern is useful for exploring Coach, but sample results are not treated as your performance.`
            : sessionCount > 0
              ? `Your recent training includes ${sessionCount} completed workouts. Calendar cadence and planned set outcomes are summarized separately without changing your plan.`
              : "There is not enough completed training yet for a meaningful trend review. Coach will become more useful as workouts and recovery check-ins are logged.",
        overallTone: sessionCount > 0 ? "positive" : "neutral",
        highlights: [
          {
            title:
              sessionCount > 0
                ? "Training history is ready to explore"
                : "A baseline comes first",
            detail:
              sessionCount > 0
                ? targetHitRate == null
                  ? "There are completed sessions, but too few measurable targets to judge target consistency."
                  : `${targetHitRate}% of working sets with measurable targets landed on target in this window.`
                : "Complete a few workouts and add the finish-workout fatigue check-in to unlock useful comparisons.",
            tone:
              targetHitRate != null && targetHitRate < 60 ? "watch" : "neutral",
            evidence: [
              `${sessionCount} completed workout${sessionCount === 1 ? "" : "s"} in the 12-week review window`,
              ...(cadenceAverage == null
                ? []
                : [
                    `${cadenceAverage} sessions per complete calendar week across ${completeWeeks} complete weeks${currentPreference == null ? "" : `; current preference ${currentPreference}/week`}`,
                  ]),
              ...(targetHitRate == null
                ? []
                : [`${targetHitRate}% of supported planned-set comparisons landed at or above target`]),
            ],
          },
        ],
        nextFocus: [
          sessionCount > 0
            ? "Keep logging completed sets and the short fatigue check-in so the next review can compare workload and recovery."
            : "Complete the next planned workout and record the working sets.",
        ],
        dataGaps: digest?.dataGaps ?? [],
      };
      return {
        value: opts.schema.parse(fixture),
        model: "fake-dev",
        latencyMs: 0,
        rawText: JSON.stringify(fixture),
        usage: fakeUsage(opts.input, fixture),
      };
    }

    if (opts.task === "coaching_qa" || opts.task === "live_coaching") {
      const input = JSON.parse(opts.input) as {
        question?: string;
        liveWorkout?: {
          name?: string;
          selectedExercise?: {
            name?: string;
            setsLogged?: unknown[];
          } | null;
        };
        context?: {
          sampleData?: { sessionCount?: number; realSessionCount?: number };
          trainingDigest?: {
            cadence?: { completedSessions?: number };
            targetOutcomes?: { atOrAboveRate?: number | null };
            dataGaps?: string[];
          };
        };
      };
      const sessionCount =
        input.context?.trainingDigest?.cadence?.completedSessions ?? 0;
      const sampleCount = input.context?.sampleData?.sessionCount ?? 0;
      const targetHitRate =
        input.context?.trainingDigest?.targetOutcomes?.atOrAboveRate;
      if (opts.task === "live_coaching") {
        const exercise = input.liveWorkout?.selectedExercise;
        const fixture = {
          answer: exercise?.name
            ? `For ${exercise.name}, keep the next step conservative: use the logged sets and your current effort as the guide, and stop if technique or comfort worsens. Coach has not changed your workout.`
            : "Keep the next decision small and base it on the sets you have actually logged, your effort, and any pain or fatigue signals. Coach has not changed your workout.",
          evidence: [
            `Current workout: ${input.liveWorkout?.name ?? "Workout"}`,
            ...(exercise?.name
              ? [
                  `Selected exercise: ${exercise.name}`,
                  `${exercise.setsLogged?.length ?? 0} logged set${exercise.setsLogged?.length === 1 ? "" : "s"}`,
                ]
              : []),
            ...(input.question ? [`Question reviewed: ${input.question}`] : []),
          ],
          dataGaps: [],
          safetyNote: null,
        };
        return {
          value: opts.schema.parse(fixture),
          model: "fake-dev",
          latencyMs: 0,
          rawText: JSON.stringify(fixture),
          usage: fakeUsage(opts.input, fixture),
        };
      }
      const fixture = {
        answer:
          sessionCount > 0
            ? `Based on the logged history, the safest answer is to keep the next step small and judge it against clean reps, effort, and recovery. ${sampleCount > 0 ? "The current view includes labelled sample workouts, so this answer is a demonstration rather than a conclusion about your real training." : "Coach has not changed your program; any adjustment still needs your approval."}`
            : "There are not enough completed workouts to answer that from your own training yet. Log a few exposures with sets and effort, then ask again for a grounded comparison.",
        evidence: [
          `${sessionCount} completed workout${sessionCount === 1 ? "" : "s"} in the current review window`,
          ...(targetHitRate == null
            ? []
            : [`${targetHitRate}% of supported planned-set comparisons landed at or above target`]),
          ...(input.question ? [`Question reviewed: ${input.question}`] : []),
        ],
        dataGaps: input.context?.trainingDigest?.dataGaps ?? [],
        safetyNote: null,
      };
      return {
        value: opts.schema.parse(fixture),
        model: "fake-dev",
        latencyMs: 0,
        rawText: JSON.stringify(fixture),
        usage: fakeUsage(opts.input, fixture),
      };
    }

    if (opts.task === "routine_build") {
      const request = JSON.parse(opts.input) as {
        availableExercises?: Array<{
          exerciseId: string;
          name: string;
          movementPattern: string;
        }>;
      };
      if (
        process.env.BA_ROUTINE_CHANGE_FIXTURE === "1" &&
        process.env.BA_FIXTURE_MODE === "1" &&
        isDisposableAcceptanceRuntime()
      ) {
        const failureMode = parseBaRoutineFailureMode(
          process.env.BA_ROUTINE_CHANGE_FAILURE_MODE,
        );
        let fixture: unknown;
        try {
          fixture = failureMode
            ? createBaRoutineBuildFailure(failureMode)
            : buildBaRoutineChangeFixture(request);
        } catch (error) {
          if (error instanceof BaRoutineBuildUnavailableError) {
            throw new AIUnavailableError();
          }
          throw error;
        }
        return {
          value: opts.schema.parse(fixture),
          model: "fake-dev-ba-routine-change",
          latencyMs: 0,
          rawText: JSON.stringify(fixture),
          usage: fakeUsage(opts.input, fixture),
        };
      }
      const available = request.availableExercises ?? [];
      const wanted = [
        "Barbell Back Squat",
        "Barbell Bench Press",
        "Dumbbell Row",
        "Romanian Deadlift",
        "Pull-Up",
      ];
      const chosen = wanted
        .map((name) => available.find((e) => e.name === name))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .slice(0, 3);
      const fallback = chosen.length
        ? chosen
        : available.slice(0, Math.min(3, available.length));
      const fixture = {
        data: {
          programName: null,
          days: [
            {
              name: "Day A",
              notes: null,
              warmupNotes: "Five minutes easy, then ramp up before the first lift.",
              exercises: fallback.map((exercise, index) => ({
                requestedName: exercise.name,
                exerciseId: exercise.exerciseId,
                sets: index === 0 ? 4 : 3,
                repMin: index === 0 ? 5 : 8,
                repMax: index === 0 ? 5 : 12,
                targetLoad: null,
                restSec: index === 0 ? 150 : 90,
                supersetGroup: null,
                notes:
                  index === 0
                    ? "Keep work sets clean and stop before grinding."
                    : null,
                warmup:
                  index === 0
                    ? {
                        notes: "Ramp up before the work sets.",
                        sets: [
                          {
                            label: "Empty bar",
                            reps: 10,
                            load: null,
                            loadUnit: null,
                            loadPercent: null,
                            loadText: "empty bar",
                            notes: null,
                          },
                          {
                            label: "~55% work weight",
                            reps: 5,
                            load: null,
                            loadUnit: null,
                            loadPercent: 55,
                            loadText: null,
                            notes: null,
                          },
                        ],
                      }
                    : null,
                setNotes:
                  index === 0
                    ? [
                        "Controlled descent; leave 1-2 reps in reserve.",
                        "Same setup and tempo.",
                        "Same setup and tempo.",
                        "Stop before ugly grinding.",
                      ]
                    : [],
              })),
            },
          ],
          rationale: "Development fake routine draft.",
        },
        confidence: 0.82,
        ambiguities: [],
        clarifyingQuestions: [],
        unparsed: [],
      };
      return {
        value: opts.schema.parse(fixture),
        model: "fake-dev",
        latencyMs: 0,
        rawText: JSON.stringify(fixture),
        usage: fakeUsage(opts.input, fixture),
      };
    }

    if (opts.task !== "equipment_parse") {
      throw new AIUnavailableError();
    }
    const fixture = {
      data: {
        items: [
          {
            type: "rack",
            label: "Power rack",
            quantity: 1,
            attrs: { minWeight: null, maxWeight: null, unit: null, adjustable: null, pair: null, increments: null, denominations: null, brand: null, barWeight: null, adjustableBench: null },
          },
          {
            type: "barbell",
            label: "Olympic barbell",
            quantity: 1,
            attrs: { minWeight: null, maxWeight: null, unit: null, adjustable: null, pair: null, increments: null, denominations: null, brand: null, barWeight: null, adjustableBench: null },
          },
          {
            type: "dumbbell",
            label: "Dumbbells up to 35",
            quantity: 1,
            attrs: { minWeight: null, maxWeight: 35, unit: null, adjustable: null, pair: null, increments: null, denominations: null, brand: null, barWeight: null, adjustableBench: null },
          },
          {
            type: "plates",
            label: "Plates",
            quantity: 1,
            attrs: { minWeight: null, maxWeight: null, unit: null, adjustable: null, pair: null, increments: null, denominations: null, brand: null, barWeight: null, adjustableBench: null },
          },
          {
            type: "bands",
            label: "Bodylastics bands",
            quantity: 1,
            attrs: { minWeight: null, maxWeight: null, unit: null, adjustable: null, pair: null, increments: null, denominations: null, brand: "Bodylastics", barWeight: null, adjustableBench: null },
          },
        ],
      },
      confidence: 0.7,
      ambiguities: [
        { field: "items[2].attrs.unit", issue: "35 lb or 35 kg dumbbells?", options: ["lb", "kg"] },
        { field: "items[2].attrs.adjustable", issue: "Adjustable or fixed dumbbells?", options: ["adjustable", "fixed"] },
        { field: "items[2].attrs.pair", issue: "A pair or a single?", options: ["pair", "single"] },
        { field: "items[3].attrs.denominations", issue: "Which plate sizes and how many of each?", options: null },
      ],
      clarifyingQuestions: ["Are the dumbbell weights in pounds or kilograms?"],
      unparsed: [],
    };
    return {
      value: opts.schema.parse(fixture),
      model: "fake-dev",
      latencyMs: 0,
      rawText: JSON.stringify(fixture),
      usage: fakeUsage(opts.input, fixture),
    };
  }
}

let provider: AIProvider | undefined;

export function getAIProvider(): AIProvider {
  return (provider ??= isFakeEnabled() && !resolveModel()
    ? new FakeProvider()
    : new SdkProvider());
}
