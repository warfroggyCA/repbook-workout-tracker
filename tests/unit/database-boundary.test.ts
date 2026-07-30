import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getRetryableSingleton } from "@/db";
import { camelRow, camelRows, resultRows } from "@/db/result";

function serviceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return serviceFiles(target);
    return /\.[cm]?tsx?$/.test(entry.name) ? [target] : [];
  });
}

describe("database boundary", () => {
  it("normalizes array and rows-object results in one place", () => {
    expect(resultRows([{ id: "array" }])).toEqual([{ id: "array" }]);
    expect(resultRows({ rows: [{ id: "object" }] })).toEqual([
      { id: "object" },
    ]);
    expect(resultRows({ rows: null })).toEqual([]);
  });

  it("normalizes top-level row keys without changing nested JSON values", () => {
    const nested = { coaching_prefs: { preferred_unit: "lb" } };
    expect(
      camelRow({
        user_id: "user-1",
        userId: "legacy-camel-value",
        alreadyCamel: "kept",
        data_digest: nested,
      })
    ).toEqual({
      userId: "user-1",
      alreadyCamel: "kept",
      dataDigest: nested,
    });
    expect(camelRows({ rows: [{ session_id: "session-1" }] })).toEqual([
      { sessionId: "session-1" },
    ]);
  });

  it("does not allow special input keys to mutate object prototypes", () => {
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"unsafe":true},"user_id":"user-1"}'
    ) as Record<string, unknown>;
    const normalized = camelRow(source);

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(normalized.userId).toBe("user-1");
  });

  it("forbids dual snake-case and camel-case row fallbacks in services", () => {
    const dualShapePattern = /\w+_\w+\s*\?\?\s*\w/g;
    const legitimateFallbacks = [
      /\?\?\s*(?:0|null|payload\.|nowLocalDate\b)/,
      /\?\?\s*row\.created_at\b/,
      /\?\?\s*recommendation\.created_at\b/,
      /process\.env\./,
    ];
    const violations = serviceFiles("src/services").flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ file, line, lineNumber: index + 1 }))
        .filter(({ line }) => {
          dualShapePattern.lastIndex = 0;
          return (
            dualShapePattern.test(line) &&
            !legitimateFallbacks.some((allowed) => allowed.test(line))
          );
        })
        .map(({ file: sourceFile, line, lineNumber }) =>
          `${sourceFile}:${lineNumber}: ${line.trim()}`
        )
    );

    expect(violations).toEqual([]);
  });

  it("shares an in-flight initialization and retries after a failure", async () => {
    const state: { value?: Promise<string> } = {};
    const create = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce("connected");

    const first = getRetryableSingleton(state, create);
    expect(getRetryableSingleton(state, create)).toBe(first);
    await expect(first).rejects.toThrow("temporarily unavailable");
    await Promise.resolve();

    await expect(getRetryableSingleton(state, create)).resolves.toBe("connected");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
