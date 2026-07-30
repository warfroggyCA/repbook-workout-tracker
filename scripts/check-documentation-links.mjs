import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "node_modules",
  "output",
  "playwright-report",
  "test-results",
]);
const textExtensions = new Set([
  ".css",
  ".env",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const requiredDocuments = [
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/ARCHITECTURE.md",
  "docs/DEVELOPMENT.md",
  "docs/SECURITY_AND_PRIVACY.md",
  "docs/PROVENANCE.md",
];
const forbiddenPaths = [
  ".claude",
  "docs/archive",
  "docs/HANDOFF.md",
  "docs/current-state.json",
  ".github/workflows/maintenance.yml",
  ".github/workflows/maintenance-heartbeat-monitor.yml",
];
const forbiddenFingerprints = new Set([
  "106c42d51e4f6d5ea27bbc1dc442ebb4d9cb9c602a633e2dd4d0b675448b2543",
  "e8c698f544712eb604c8795913f996b593295146998134187e2bacfd1d81e1fd",
  "650edf025063afe71c73b80065045b63f4876dcbaae046d5a03f302873cd8e8c",
  "1f30809943c4966796ad298cddf7ef977d88f5f9dcb37ffa5b58ef6ae7278b98",
]);
const forbiddenIdentifierPatterns = [
  /\bdpl_[A-Za-z0-9]{8,}\b/g,
  /\bbr-[a-z]+-[a-z]+-[a-z0-9]{6,}\b/g,
];

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...collectFiles(join(directory, entry.name)));
      }
      continue;
    }
    if (textExtensions.has(extname(entry.name)) || entry.name === ".env.example") {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function fingerprint(value) {
  return createHash("sha256").update(value.toLowerCase()).digest("hex");
}

function privateIdentifierCandidates(source) {
  const candidates = [];
  const patterns = [
    /[A-Z][a-z]+\s+[A-Z][a-z]+/g,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    /https?:\/\/([A-Za-z0-9.-]+)/g,
    /\b[A-Za-z][A-Za-z0-9_-]{5,}\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      candidates.push({
        index: match.index,
        values: [match[0], match[1]].filter(Boolean),
      });
    }
  }
  return candidates;
}

const failures = [];

for (const document of requiredDocuments) {
  if (!existsSync(resolve(root, document))) {
    failures.push(`Missing required public document: ${document}`);
  }
}

for (const path of forbiddenPaths) {
  if (existsSync(resolve(root, path))) {
    failures.push(`Private-only path must not be published: ${path}`);
  }
}

for (const file of collectFiles(root)) {
  const source = readFileSync(file, "utf8");
  const relativeFile = file.slice(root.length + 1);

  for (const candidate of privateIdentifierCandidates(source)) {
    if (candidate.values.some((value) =>
      forbiddenFingerprints.has(fingerprint(value)))) {
      failures.push(
        `${relativeFile}:${lineNumber(source, candidate.index)} contains a private identifier`,
      );
    }
  }

  for (const pattern of forbiddenIdentifierPatterns) {
    const match = pattern.exec(source);
    pattern.lastIndex = 0;
    if (match) {
      failures.push(
        `${relativeFile}:${lineNumber(source, match.index)} contains a private operational identifier`,
      );
    }
  }

  if (extname(file) === ".md") {
    for (const match of source.matchAll(/]\(([^)]+)\)/g)) {
      let target = match[1].trim().replace(/^<|>$/g, "");
      target = target.split(/\s+["']/)[0];
      if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
      target = target.split("#")[0];
      try {
        target = decodeURIComponent(target);
      } catch {
        failures.push(
          `${relativeFile}:${lineNumber(source, match.index)} has an invalid encoded link`,
        );
        continue;
      }
      if (!existsSync(resolve(file, "..", target))) {
        failures.push(
          `${relativeFile}:${lineNumber(source, match.index)} has a broken link: ${match[1]}`,
        );
      }
    }
  }

  for (const match of source.matchAll(
    /`(docs\/[A-Za-z0-9_./-]+\.(?:json|md))`/g,
  )) {
    if (!existsSync(resolve(root, match[1]))) {
      failures.push(
        `${relativeFile}:${lineNumber(source, match.index)} references a missing document: ${match[1]}`,
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Public documentation and privacy checks passed.\n");
