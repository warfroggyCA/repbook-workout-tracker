import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sanitizeBaEvidenceText,
  writeBaCheckpointAudit,
  type BaCheckpointAudit,
} from "../helpers/ba-audit";

const roots: string[] = [];

async function freshRoot() {
  const root = await mkdtemp(join(tmpdir(), "ba-audit-test-"));
  roots.push(root);
  return root;
}

function audit(overrides: Partial<BaCheckpointAudit> = {}): BaCheckpointAudit {
  return {
    checkpointId: "BA-03-FAILURE-01",
    preconditions: "The disposable Program is unchanged.",
    action: "Submit one controlled fake-provider failure.",
    expected: "No partial mutation occurs.",
    observed: "The draft remained unchanged.",
    status: "pass",
    severity: "none",
    url: "http://127.0.0.1:3110/program/edit?token=private-value",
    calibration: {
      viewport: { width: 440, height: 956 },
      screen: { width: 440, height: 956 },
      deviceScaleFactor: 2,
      mobile: true,
      touch: true,
      touchPoints: 1,
      userAgent: "Acceptance iPhone user agent",
      locale: "en-CA",
      timezone: "America/Toronto",
    },
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    followUp: null,
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BA checkpoint audit writer", () => {
  it("writes immutable sanitized JSON and Markdown and attaches both", async () => {
    const root = await freshRoot();
    const screenshot = join(root, "today.png");
    await writeFile(screenshot, "synthetic image");
    const attach = vi.fn(async () => undefined);
    const result = await writeBaCheckpointAudit({
      evidenceRoot: root,
      attach,
      audit: audit({
        observed: "DATABASE_URL=postgresql://owner:secret@example.test/production and sk-ant-dangerousvalue",
        failedRequests: [
          {
            method: "POST",
            url: "https://example.test/action?secret=hidden&safe=shown",
            reason: "Authorization: Bearer private-token",
            status: 500,
          },
        ],
        artifacts: [{ label: "Today", kind: "screenshot", path: screenshot }],
      }),
    });

    const json = await readFile(result.jsonPath, "utf8");
    const markdown = await readFile(result.markdownPath, "utf8");
    expect(json).not.toContain("owner:secret");
    expect(json).not.toContain("dangerousvalue");
    expect(json).not.toContain("private-token");
    expect(json).not.toContain("hidden");
    expect(json).toContain("REDACTED");
    expect(json).toContain('"path": "today.png"');
    expect(markdown).toContain("# BA-03-FAILURE-01");
    expect(markdown).toContain("No partial mutation occurs.");
    expect(markdown).toContain("[Today](../../today.png)");
    const artifactLinks = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(
      (match) => match[1]!,
    );
    expect(artifactLinks).not.toHaveLength(0);
    for (const artifactLink of artifactLinks) {
      expect((await stat(resolve(dirname(result.markdownPath), artifactLink))).isFile()).toBe(true);
    }
    expect(markdown).toContain(
      "Not captured by the browser process; inspect the Playwright web-server output.",
    );
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("never overwrites an existing checkpoint", async () => {
    const root = await freshRoot();
    await writeBaCheckpointAudit({ evidenceRoot: root, audit: audit() });
    await expect(
      writeBaCheckpointAudit({ evidenceRoot: root, audit: audit({ observed: "different" }) }),
    ).rejects.toThrow("will not be overwritten");
  });

  it("refuses checkpoint traversal and artifacts outside the evidence root", async () => {
    const root = await freshRoot();
    const outside = join(tmpdir(), `outside-${crypto.randomUUID()}.txt`);
    await writeFile(outside, "outside");
    roots.push(outside);
    await expect(
      writeBaCheckpointAudit({
        evidenceRoot: root,
        audit: audit({ checkpointId: "../escape" }),
      }),
    ).rejects.toThrow("checkpoint IDs");
    await expect(
      writeBaCheckpointAudit({
        evidenceRoot: root,
        audit: audit({ artifacts: [{ label: "Outside", kind: "other", path: outside }] }),
      }),
    ).rejects.toThrow("inside the supplied BA evidence root");
  });

  it("requires an existing directory as its fresh evidence root", async () => {
    const root = await freshRoot();
    const file = join(root, "not-a-directory");
    await writeFile(file, "file");
    await expect(writeBaCheckpointAudit({ evidenceRoot: file, audit: audit() })).rejects.toThrow(
      "must be a directory",
    );
  });

  it("sanitizes common credential forms without removing ordinary evidence", () => {
    expect(
      sanitizeBaEvidenceText(
        "POST https://example.test/path?token=hidden&view=month Authorization: Bearer abc.def",
      ),
    ).toContain("view=month");
    expect(
      sanitizeBaEvidenceText(
        "POST https://example.test/path?token=hidden&view=month Authorization: Bearer abc.def",
      ),
    ).not.toContain("hidden");
  });
});
