import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import ledger from "./silent-catch-ledger.json";

const ROOTS = ["src/app/actions", "src/app/api", "src/services"];

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.[cm]?tsx?$/.test(entry.name) ? [target] : [];
  });
}

function isHandledCatch(node: ts.CatchClause, source: ts.SourceFile): boolean {
  let handled = false;
  const caughtName = node.variableDeclaration?.name.getText(source);
  const isOnlyConsoleOutput = (candidate: ts.Node): boolean => {
    let current: ts.Node | undefined = candidate.parent;
    while (current && current !== node.block) {
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.expression.getText(source) === "console"
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };
  const inspect = (child: ts.Node) => {
    if (ts.isThrowStatement(child)) handled = true;
    if (
      ts.isCallExpression(child) &&
      child.expression.getText(source) === "logDiagnosticEvent"
    ) {
      handled = true;
    }
    if (
      caughtName &&
      ts.isIdentifier(child) &&
      child.text === caughtName &&
      child !== node.variableDeclaration?.name &&
      !isOnlyConsoleOutput(child)
    ) {
      handled = true;
    }
    ts.forEachChild(child, inspect);
  };
  ts.forEachChild(node.block, inspect);
  return handled;
}

function silentCatchCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of ROOTS.flatMap(sourceFiles)) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    let count = 0;
    const inspect = (node: ts.Node) => {
      if (ts.isCatchClause(node) && !isHandledCatch(node, source)) count += 1;
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    if (count > 0) counts[file] = count;
  }
  return counts;
}

describe("server silent catch ledger", () => {
  it("requires every intentionally silent catch to have a reviewed reason", () => {
    const reasons = ledger as Record<string, string[]>;
    for (const [file, entries] of Object.entries(reasons)) {
      expect(file).toMatch(/^src\/(?:app\/(?:actions|api)|services)\//);
      expect(entries.length).toBeGreaterThan(0);
      for (const reason of entries) expect(reason.trim().length).toBeGreaterThan(10);
    }

    expect(silentCatchCounts()).toEqual(
      Object.fromEntries(
        Object.entries(reasons).map(([file, entries]) => [file, entries.length])
      )
    );
  });
});
