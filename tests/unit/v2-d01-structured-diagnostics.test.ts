import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_EVENT_NAMES } from "@/lib/server-log";

const SOURCE_ROOTS = ["src/ai", "src/app", "src/services"];

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.[cm]?tsx?$/.test(entry.name) ? [target] : [];
  });
}

type DiagnosticCall = {
  event: string;
  fieldNames: string[];
  file: string;
};

function diagnosticCalls(): DiagnosticCall[] {
  const calls: DiagnosticCall[] = [];
  for (const file of SOURCE_ROOTS.flatMap(sourceFiles)) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const inspect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "logDiagnosticEvent"
      ) {
        const eventNode = node.arguments[0];
        const fieldsNode = node.arguments[1];
        expect(ts.isStringLiteral(eventNode), file).toBe(true);
        expect(ts.isObjectLiteralExpression(fieldsNode), file).toBe(true);
        if (
          ts.isStringLiteral(eventNode) &&
          ts.isObjectLiteralExpression(fieldsNode)
        ) {
          calls.push({
            event: eventNode.text,
            file,
            fieldNames: fieldsNode.properties.flatMap((property) => {
              if (
                (ts.isPropertyAssignment(property) ||
                  ts.isShorthandPropertyAssignment(property)) &&
                property.name
              ) {
                return [property.name.getText(source).replaceAll(/["']/g, "")];
              }
              return [];
            }),
          });
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  return calls;
}

describe("Repbook v2 D01 structured diagnostics inventory", () => {
  it("routes every production diagnostic through the closed event vocabulary", () => {
    const calls = diagnosticCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect([...new Set(calls.map((call) => call.event))].sort()).toEqual(
      [...DIAGNOSTIC_EVENT_NAMES].sort(),
    );

    for (const file of new Set(calls.map((call) => call.file))) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toContain("logServerEvent");
      expect(source, file).not.toMatch(/console\.(?:debug|error|info|log|warn)\(/);
    }
  });

  it("does not offer sensitive record or error-text fields at call sites", () => {
    const forbidden = new Set([
      "attachmentKind",
      "entityId",
      "errorMessage",
      "errorName",
      "errorType",
      "exerciseName",
      "importEventId",
      "inputTokens",
      "jobId",
      "leaseId",
      "message",
      "model",
      "note",
      "outputTokens",
      "pain",
      "providerBody",
      "reasoningTokens",
      "reps",
      "responseId",
      "sessionId",
      "snapshotId",
      "task",
      "templateId",
      "trainingDate",
      "usageId",
      "userId",
      "versionId",
      "weight",
    ]);

    for (const call of diagnosticCalls()) {
      for (const fieldName of call.fieldNames) {
        expect(forbidden.has(fieldName), `${call.file}: ${fieldName}`).toBe(
          false,
        );
      }
    }
  });
});
