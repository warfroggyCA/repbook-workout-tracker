import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

export type BaCheckpointStatus =
  | "pass"
  | "fail"
  | "blocked"
  | "emulation-limited";

export type BaCheckpointSeverity =
  | "blocker"
  | "high"
  | "medium"
  | "low"
  | "none";

export type BaDeviceCalibration = {
  viewport: { width: number; height: number };
  screen?: { width: number; height: number };
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  touchPoints?: number;
  userAgent: string;
  locale: string;
  timezone: string;
};

export type BaCheckpointArtifact = {
  label: string;
  kind:
    | "screenshot"
    | "trace"
    | "video"
    | "console"
    | "network"
    | "surface-audit"
    | "accessibility"
    | "other";
  path: string;
};

export type BaCheckpointAudit = {
  checkpointId: string;
  preconditions: string;
  action: string;
  expected: string;
  observed: string;
  status: BaCheckpointStatus;
  severity: BaCheckpointSeverity;
  url: string;
  calibration: BaDeviceCalibration;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{
    method: string;
    url: string;
    reason: string;
    status?: number | null;
  }>;
  serverErrors?: string[];
  followUp?: string | null;
  artifacts?: BaCheckpointArtifact[];
};

export type BaAuditAttachment = (
  name: string,
  options: { path: string; contentType: string },
) => Promise<void>;

const CHECKPOINT_ID = /^[A-Z0-9][A-Z0-9._-]{1,79}$/i;
const SENSITIVE_NAME =
  /(authorization|cookie|credential|database_url|password|provider.?key|secret|token)/i;
const DATABASE_URL = /(?:postgres(?:ql)?|neon):\/\/[^\s"'<>]+/gi;
const API_KEY = /\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const NAMED_SECRET = new RegExp(
  `\\b([A-Z0-9_.-]*${SENSITIVE_NAME.source}[A-Z0-9_.-]*)\\s*[:=]\\s*([^\\s,;&]+)`,
  "gi",
);

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "REDACTED";
    if (url.password) url.password = "REDACTED";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_NAME.test(key)) url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeBaEvidenceText(value: string): string {
  const sanitized = value
    .replace(DATABASE_URL, "[REDACTED DATABASE URL]")
    .replace(API_KEY, "[REDACTED PROVIDER KEY]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(NAMED_SECRET, "$1=[REDACTED]");
  return /^https?:\/\//i.test(sanitized) ? sanitizeUrl(sanitized) : sanitized;
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_NAME.test(key)) return "[REDACTED]";
  if (typeof value === "string") return sanitizeBaEvidenceText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function assertInside(root: string, target: string, label: string): void {
  const fromRoot = relative(root, target);
  if (
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    resolve(root, fromRoot) !== target
  ) {
    throw new Error(`${label} must stay inside the supplied BA evidence root.`);
  }
}

function markdownText(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line || " "}`)
    .join("\n");
}

function renderMarkdown(audit: BaCheckpointAudit): string {
  const failedRequests = audit.failedRequests.length
    ? audit.failedRequests
        .map(
          (request) =>
            `- ${request.method} ${request.url} — ${request.reason}${request.status == null ? "" : ` (HTTP ${request.status})`}`,
        )
        .join("\n")
    : "- None";
  const artifacts = audit.artifacts?.length
    ? audit.artifacts
        .map((artifact) => `- ${artifact.kind}: [${artifact.label}](${artifact.path})`)
        .join("\n")
    : "- None";
  const serverErrors = audit.serverErrors === undefined
    ? "- Not captured by the browser process; inspect the Playwright web-server output."
    : audit.serverErrors.length
      ? audit.serverErrors.map((error) => `- ${error}`).join("\n")
      : "- None observed by the configured server-error capture.";
  return `# ${audit.checkpointId}\n\n` +
    `- Status: ${audit.status}\n` +
    `- Severity: ${audit.severity}\n` +
    `- URL: ${audit.url}\n\n` +
    `## Preconditions\n\n${markdownText(audit.preconditions)}\n\n` +
    `## Action\n\n${markdownText(audit.action)}\n\n` +
    `## Expected\n\n${markdownText(audit.expected)}\n\n` +
    `## Observed\n\n${markdownText(audit.observed)}\n\n` +
    `## Device calibration\n\n\`\`\`json\n${JSON.stringify(audit.calibration, null, 2)}\n\`\`\`\n\n` +
    `## Console errors\n\n${audit.consoleErrors.length ? audit.consoleErrors.map((error) => `- ${error}`).join("\n") : "- None"}\n\n` +
    `## Page errors\n\n${audit.pageErrors.length ? audit.pageErrors.map((error) => `- ${error}`).join("\n") : "- None"}\n\n` +
    `## Failed requests\n\n${failedRequests}\n\n` +
    `## Server errors\n\n${serverErrors}\n\n` +
    `## Artifacts\n\n${artifacts}\n\n` +
    `## Follow-up\n\n${markdownText(audit.followUp ?? "None")}\n`;
}

export async function writeBaCheckpointAudit(input: {
  evidenceRoot: string;
  audit: BaCheckpointAudit;
  attach?: BaAuditAttachment;
}): Promise<{ directory: string; jsonPath: string; markdownPath: string }> {
  if (!CHECKPOINT_ID.test(input.audit.checkpointId)) {
    throw new Error("BA checkpoint IDs may contain only letters, digits, dots, underscores, and hyphens.");
  }
  const rootStats = await stat(input.evidenceRoot);
  if (!rootStats.isDirectory()) throw new Error("The supplied BA evidence root must be a directory.");
  const root = await realpath(input.evidenceRoot);

  const artifacts: BaCheckpointArtifact[] = [];
  for (const artifact of input.audit.artifacts ?? []) {
    const artifactPath = await realpath(artifact.path);
    assertInside(root, artifactPath, `Artifact ${artifact.label}`);
    artifacts.push({
      ...artifact,
      path: relative(root, artifactPath).split(sep).join("/"),
    });
  }

  const sanitized = sanitizeValue({ ...input.audit, artifacts }) as BaCheckpointAudit;
  const checkpointsRoot = resolve(root, "checkpoints");
  assertInside(root, checkpointsRoot, "Checkpoint directory");
  await mkdir(checkpointsRoot, { recursive: true });
  assertInside(
    root,
    await realpath(checkpointsRoot),
    "Resolved checkpoint directory",
  );
  const directory = resolve(checkpointsRoot, sanitized.checkpointId);
  assertInside(root, directory, "Checkpoint directory");
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`BA checkpoint ${sanitized.checkpointId} already exists and will not be overwritten.`);
    }
    throw error;
  }

  const stem = basename(directory);
  const jsonPath = resolve(directory, `${stem}.json`);
  const markdownPath = resolve(directory, `${stem}.md`);
  const markdownAudit: BaCheckpointAudit = {
    ...sanitized,
    artifacts: sanitized.artifacts?.map((artifact) => ({
      ...artifact,
      path: relative(directory, resolve(root, artifact.path))
        .split(sep)
        .join("/"),
    })),
  };
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, { flag: "wx" }),
    writeFile(markdownPath, renderMarkdown(markdownAudit), { flag: "wx" }),
  ]);

  if (input.attach) {
    await input.attach(`${stem}-audit-json`, {
      path: jsonPath,
      contentType: "application/json",
    });
    await input.attach(`${stem}-audit-markdown`, {
      path: markdownPath,
      contentType: "text/markdown",
    });
  }
  return { directory, jsonPath, markdownPath };
}
