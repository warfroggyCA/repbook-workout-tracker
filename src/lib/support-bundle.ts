export const SUPPORT_BUNDLE_SCHEMA_VERSION = "support-bundle/1";
export const SUPPORT_BUNDLE_REDACTION_VERSION = "support-redaction/1";
export const SUPPORT_BUNDLE_PURPOSE = "repbook_support_diagnosis";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_NOTE_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

export type SupportContextValues = Readonly<{
  browserFamily?: "chromium" | "firefox" | "other" | "safari";
  downloadSupport?: boolean;
  online?: boolean;
  viewportClass?: "narrow" | "standard" | "wide";
}>;

export type SupportContextCollection =
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "error"; errorCategory: "runtime" }>
  | Readonly<{ status: "populated"; values: SupportContextValues }>;

type ContextKey = keyof SupportContextValues;

const PROBLEM_DEFINITIONS = {
  coach_or_review: {
    label: "Coach or Review did not respond",
    description:
      "Records only a coarse availability outcome and connection state.",
    contextFields: ["online"] as const,
    observedStates: {
      response_missing: "No response appeared",
      timed_out: "The request timed out",
      unavailable: "The feature reported that it was unavailable",
    },
  },
  export_or_recovery: {
    label: "Export or Recovery did not work",
    description:
      "Records only coarse browser and download capability needed for a local-file problem.",
    contextFields: ["browserFamily", "downloadSupport"] as const,
    observedStates: {
      download_missing: "The download did not appear",
      file_rejected: "Repbook rejected the selected file",
      operation_failed: "The operation reported a failure",
    },
  },
  page_display: {
    label: "A page looked or behaved incorrectly",
    description:
      "Records only coarse browser and viewport categories needed for a display problem.",
    contextFields: ["browserFamily", "viewportClass"] as const,
    observedStates: {
      blank_or_incomplete: "The page was blank or incomplete",
      controls_unavailable: "Controls were missing or could not be used",
      layout_overflow: "Content was clipped or extended off screen",
    },
  },
  workout_start: {
    label: "A workout would not start",
    description:
      "Records only a coarse start outcome and connection state, never the workout contents.",
    contextFields: ["online"] as const,
    observedStates: {
      active_workout_conflict: "Repbook reported another active workout",
      start_failed: "The workout did not start",
      start_rejected: "Repbook rejected the start request",
    },
  },
} as const;

export const SUPPORT_PROBLEMS = PROBLEM_DEFINITIONS;
export type SupportProblemType = keyof typeof SUPPORT_PROBLEMS;
export type SupportObservedState = string;

export type SupportBundle = Readonly<{
  schemaVersion: typeof SUPPORT_BUNDLE_SCHEMA_VERSION;
  redactionVersion: typeof SUPPORT_BUNDLE_REDACTION_VERSION;
  purpose: typeof SUPPORT_BUNDLE_PURPOSE;
  correlationId: string;
  generatedAt: string;
  application: Readonly<{
    name: "Repbook";
    version: string;
  }>;
  problem: Readonly<{
    type: SupportProblemType;
    errorCode: SupportObservedState;
  }>;
  diagnosticContext?: Readonly<{
    collectionStatus: "empty" | "error" | "populated";
    errorCategory?: "runtime";
    observations?: SupportContextValues;
  }>;
  ownerProvided?: Readonly<{
    freeText: string;
    mayContainPrivateTrainingOrHealthDetails: true;
  }>;
  privacy: Readonly<{
    localExportOnly: true;
    automaticUpload: false;
    stableIdentityIncluded: false;
    automaticTrainingFactCollection: false;
    serverDiagnosticLogLinesIncluded: false;
    aiAnalysisContentIncluded: false;
  }>;
  inventory: Readonly<{
    includedPaths: readonly string[];
    optionalSectionsRemoved: readonly string[];
    excludedAutomaticSources: readonly string[];
  }>;
}>;

export type BuildSupportBundleInput = Readonly<{
  appVersion: string;
  correlationId: string;
  generatedAt: string;
  problemType: SupportProblemType;
  observedState: SupportObservedState;
  includeDiagnosticContext: boolean;
  diagnosticContext?: SupportContextCollection;
  includeOwnerNote: boolean;
  ownerNote?: string;
}>;

function problemDefinition(problemType: string) {
  return (PROBLEM_DEFINITIONS as Record<
    string,
    | Readonly<{
        contextFields: readonly ContextKey[];
        observedStates: Readonly<Record<string, string>>;
      }>
    | undefined
  >)[problemType];
}

function validContextValue(key: ContextKey, value: unknown) {
  switch (key) {
    case "browserFamily":
      return ["chromium", "firefox", "other", "safari"].includes(
        value as string,
      );
    case "downloadSupport":
    case "online":
      return typeof value === "boolean";
    case "viewportClass":
      return ["narrow", "standard", "wide"].includes(value as string);
  }
}

function filteredContext(
  allowed: readonly ContextKey[],
  values: SupportContextValues,
): SupportContextValues {
  return Object.fromEntries(
    allowed.flatMap((key) =>
      validContextValue(key, values[key]) ? [[key, values[key]]] : [],
    ),
  ) as SupportContextValues;
}

function buildDiagnosticContext(
  definition: Readonly<{ contextFields: readonly ContextKey[] }>,
  collection: SupportContextCollection | undefined,
) {
  if (!collection || collection.status === "empty") {
    return { collectionStatus: "empty" } as const;
  }
  if (collection.status === "error") {
    return {
      collectionStatus: "error",
      errorCategory: "runtime",
    } as const;
  }
  const observations = filteredContext(
    definition.contextFields,
    collection.values,
  );
  return Object.keys(observations).length === 0
    ? ({ collectionStatus: "empty" } as const)
    : ({ collectionStatus: "populated", observations } as const);
}

export function buildSupportBundle(
  input: BuildSupportBundleInput,
): SupportBundle {
  const definition = problemDefinition(input.problemType);
  if (!definition) throw new Error("Select a supported problem type.");
  if (!(input.observedState in definition.observedStates)) {
    throw new Error("Select an outcome that belongs to this problem.");
  }
  if (!UUID_PATTERN.test(input.correlationId)) {
    throw new Error("The local bundle correlation could not be created.");
  }
  const generatedAt = new Date(input.generatedAt);
  if (
    !Number.isFinite(generatedAt.getTime()) ||
    generatedAt.toISOString() !== input.generatedAt
  ) {
    throw new Error("The local bundle time is invalid.");
  }
  if (
    typeof input.appVersion !== "string" ||
    input.appVersion.length < 1 ||
    input.appVersion.length > 64
  ) {
    throw new Error("The application version is invalid.");
  }

  let ownerProvided: SupportBundle["ownerProvided"];
  if (input.includeOwnerNote) {
    const note = input.ownerNote?.trim() ?? "";
    if (note.length < 1 || note.length > 500 || UNSAFE_NOTE_PATTERN.test(note)) {
      throw new Error(
        "The optional note must be 1 to 500 plain-text characters.",
      );
    }
    ownerProvided = {
      freeText: note,
      mayContainPrivateTrainingOrHealthDetails: true,
    };
  }

  const diagnosticContext = input.includeDiagnosticContext
    ? buildDiagnosticContext(definition, input.diagnosticContext)
    : undefined;
  const contextPaths =
    diagnosticContext?.observations == null
      ? []
      : Object.keys(diagnosticContext.observations)
          .sort()
          .map((key) => `diagnosticContext.observations.${key}`);

  return {
    schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
    redactionVersion: SUPPORT_BUNDLE_REDACTION_VERSION,
    purpose: SUPPORT_BUNDLE_PURPOSE,
    correlationId: input.correlationId,
    generatedAt: input.generatedAt,
    application: { name: "Repbook", version: input.appVersion },
    problem: {
      type: input.problemType,
      errorCode: input.observedState,
    },
    ...(diagnosticContext ? { diagnosticContext } : {}),
    ...(ownerProvided ? { ownerProvided } : {}),
    privacy: {
      localExportOnly: true,
      automaticUpload: false,
      stableIdentityIncluded: false,
      automaticTrainingFactCollection: false,
      serverDiagnosticLogLinesIncluded: false,
      aiAnalysisContentIncluded: false,
    },
    inventory: {
      includedPaths: [
        "schemaVersion",
        "redactionVersion",
        "purpose",
        "correlationId",
        "generatedAt",
        "application.name",
        "application.version",
        "problem.type",
        "problem.errorCode",
        ...(diagnosticContext
          ? ["diagnosticContext.collectionStatus"]
          : []),
        ...(diagnosticContext?.errorCategory
          ? ["diagnosticContext.errorCategory"]
          : []),
        ...contextPaths,
        ...(ownerProvided
          ? [
              "ownerProvided.freeText",
              "ownerProvided.mayContainPrivateTrainingOrHealthDetails",
            ]
          : []),
        "privacy",
        "inventory",
      ],
      optionalSectionsRemoved: [
        ...(!diagnosticContext ? ["diagnosticContext"] : []),
        ...(!ownerProvided ? ["ownerProvided"] : []),
      ],
      excludedAutomaticSources: [
        "account_identity",
        "record_identifiers",
        "training_and_health_facts",
        "server_diagnostic_log_lines",
        "ai_analysis_packages_and_responses",
        "provider_payloads",
        "secrets",
        "database_rows",
      ],
    },
  };
}

export function serializeSupportBundle(bundle: SupportBundle) {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function supportBundleFilename(bundle: SupportBundle) {
  return `repbook-support-${bundle.problem.type}-${bundle.generatedAt.slice(0, 10)}.json`;
}

export function collectBrowserSupportContext(): SupportContextCollection {
  try {
    if (typeof navigator === "undefined" || typeof window === "undefined") {
      return { status: "empty" };
    }
    const userAgent = navigator.userAgent.toLowerCase();
    const browserFamily: NonNullable<SupportContextValues["browserFamily"]> =
      /firefox|fxios/.test(userAgent)
        ? "firefox"
        : /edg|chrome|chromium|crios/.test(userAgent)
          ? "chromium"
          : /safari/.test(userAgent)
            ? "safari"
            : "other";
    const viewportClass: NonNullable<SupportContextValues["viewportClass"]> =
      window.innerWidth <= 480
        ? "narrow"
        : window.innerWidth <= 1280
          ? "standard"
          : "wide";
    return {
      status: "populated",
      values: {
        browserFamily,
        downloadSupport:
          typeof Blob === "function" &&
          typeof URL?.createObjectURL === "function",
        online: navigator.onLine,
        viewportClass,
      },
    };
  } catch {
    return { status: "error", errorCategory: "runtime" };
  }
}
