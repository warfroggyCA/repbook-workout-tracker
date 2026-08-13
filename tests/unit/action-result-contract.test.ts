import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ACTION_FILES = [
  "src/app/actions/sessions.ts",
  "src/app/actions/history.ts",
];

const CALL_SITE_ROOTS = ["src/app", "src/components"];

const PROGRAMMER_ERROR_ALLOWLIST = [
  "The restored exercise could not be loaded.",
  "The restored exercise could not be loaded.",
];

function parse(file: string) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function thrownErrorMessages(file: string): string[] {
  const source = parse(file);
  const messages: string[] = [];
  const inspect = (node: ts.Node) => {
    if (
      ts.isThrowStatement(node) &&
      node.expression &&
      ts.isNewExpression(node.expression) &&
      node.expression.expression.getText(source) === "Error"
    ) {
      const argument = node.expression.arguments?.[0];
      messages.push(
        argument && ts.isStringLiteralLike(argument)
          ? argument.text
          : `<non-literal:${node.getStart(source)}>`
      );
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return messages;
}

/**
 * An action communicates expected failure as a named result when it builds one
 * with actionFailure(), returns an `ok` discriminant, or propagates a helper's
 * result. Deriving the list keeps this contract accurate as actions change.
 */
function resultReturningActions(file: string): string[] {
  const source = parse(file);
  const names: string[] = [];
  const inspect = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const body = node.body?.getText(source) ?? "";
      if (/\bok:\s*(?:true|false)\b/.test(body) || body.includes("actionFailure(")) {
        names.push(node.name.text);
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return names;
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Call sites that invoke an action as a statement and discard its result. */
function discardedActionResults(file: string, actions: Set<string>): string[] {
  const text = fs.readFileSync(file, "utf8");
  if (!/from\s+["']@\/app\/actions\//.test(text)) return [];
  const source = parse(file);
  const violations: string[] = [];
  const inspect = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      actions.has(node.expression.text)
    ) {
      const valueNode =
        node.parent && ts.isAwaitExpression(node.parent) ? node.parent : node;
      if (node.parent && ts.isExpressionStatement(valueNode.parent)) {
        const line =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        violations.push(`${file}:${line} ${node.expression.text}`);
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return violations;
}

describe("server action result contract", () => {
  it("keeps user guidance out of thrown server-action errors", () => {
    expect(thrownErrorMessages(ACTION_FILES[0])).toEqual(
      PROGRAMMER_ERROR_ALLOWLIST
    );
    expect(thrownErrorMessages(ACTION_FILES[1])).toEqual([]);
  });

  it("identifies the actions whose failures are named results", () => {
    // Guards the derivation itself: a silently empty list would make the
    // call-site check below vacuous.
    expect(resultReturningActions(ACTION_FILES[0])).toEqual(
      expect.arrayContaining([
        "correctAcknowledgedSet",
        "archiveSet",
        "skipExercise",
        "confirmExerciseUnskipped",
        "substituteExercise",
        "undoExerciseSubstitution",
        "logPain",
        "saveExerciseNote",
      ])
    );
  });

  it("never discards a named action result at a call site", () => {
    // A discarded result is a silently swallowed failure: the action returns
    // { ok: false } instead of throwing, so no catch block ever runs and the
    // interface proceeds as though the operation succeeded.
    const actions = new Set(ACTION_FILES.flatMap(resultReturningActions));
    expect(actions.size).toBeGreaterThan(0);
    const violations = CALL_SITE_ROOTS.flatMap((root) =>
      sourceFiles(root).flatMap((file) => discardedActionResults(file, actions))
    );
    expect(violations).toEqual([]);
  });
});
