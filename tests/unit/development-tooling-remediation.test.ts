import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";

const require = createRequire(import.meta.url);
const root = process.cwd();
const vendor = resolve("tools/next-eslint");
const { getRootDirs } = require("../../tools/next-eslint/plugin/utils/get-root-dirs.js");
const plugin = require("../../tools/next-eslint/plugin").default;
const baseline = JSON.parse(readFileSync("tests/fixtures/tooling/next-eslint-16.4.2.json", "utf8"));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const cleanup: string[] = [];
afterEach(() => { for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "repbook-lint-roots-"));
  cleanup.push(dir);
  for (const path of ["pages", "app/account", "apps/one", ".hidden"]) mkdirSync(join(dir, path), { recursive: true });
  writeFileSync(join(dir, "pages/index.js"), "export default function Page() { return null; }");
  writeFileSync(join(dir, "app/account/page.js"), "export default function Page() { return null; }");
  writeFileSync(join(dir, "ordinary.txt"), "synthetic");
  symlinkSync(join(dir, "apps/one"), join(dir, "linked"));
  return dir;
}

describe("development dependency remediation", () => {
  it("retains every upstream rule byte and only the reviewed integration changes", () => {
    const provenance = JSON.parse(readFileSync(join(vendor, "upstream.json"), "utf8"));
    const application = JSON.parse(readFileSync("package.json", "utf8"));
    expect(application.dependencies.next).toBe(provenance["@next/eslint-plugin-next"].version);
    const changed: string[] = [];
    for (const name of ["eslint-config-next", "@next/eslint-plugin-next"]) {
      expect(provenance[name].version).toBe("16.4.2");
      expect(provenance[name].tarball).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(provenance[name].integrity).toMatch(/^sha512-/);
      for (const [path, digest] of Object.entries(provenance[name].files)) {
        if (hash(readFileSync(join(vendor, path))) !== digest) changed.push(path);
      }
    }
    expect(changed.sort()).toEqual([...provenance.modifiedFiles].sort());
    expect(readdirSync(join(vendor, "plugin/rules")).filter((name) => name.endsWith(".js"))).toHaveLength(22);
    expect(Object.keys(plugin.rules)).toHaveLength(22);
    expect(provenance.modifiedFiles.some((file: string) => file.startsWith("plugin/rules/"))).toBe(false);
  });

  it.each([
    ["src/app/page.tsx", "typescript"], ["src/services/workouts.ts", "typescript"],
    ["scripts/check-dependency-audit.mjs", "javascript"], ["eslint.config.mjs", "javascript"],
  ])("preserves the complete effective config for %s", async (file, kind) => {
    const config = await new ESLint().calculateConfigForFile(file);
    const actual = { rules: config.rules, settings: config.settings, plugins: Object.keys(config.plugins).sort(),
      languageOptions: { ...config.languageOptions, parser: { meta: config.languageOptions.parser?.meta } } };
    expect(JSON.parse(JSON.stringify(actual).split(root).join("<PROJECT>"))).toEqual(baseline[kind]);
  });

  it("preserves CSS bytes, license and application import", () => {
    expect(hash(readFileSync("vendor/shadcn/tailwind.css"))).toBe("bc7d83425702955b4cb67cb14ede9d603f9d912376d57a2d81d661094d2a782a");
    expect(hash(readFileSync("vendor/shadcn/shadcn.LICENSE.md"))).toBe("1564074e13439397221ffd522e2e504d56561994a23d371aa5e3ad43e4f5423f");
    expect(readFileSync("src/app/globals.css", "utf8")).toContain('@import "../../vendor/shadcn/tailwind.css";');
  });

  it("removes all vulnerable paths from the real dependency lock", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    for (const path of Object.keys(lock.packages)) {
      expect(path).not.toMatch(/(?:^|\/)node_modules\/(?:braces|micromatch|fast-glob|shadcn|eslint-config-next|@next\/eslint-plugin-next)$/);
    }
    expect(lock.packages["tools/next-eslint"].dev).toBe(true);
    expect(lock.packages["node_modules/@repbook/next-eslint"].link).toBe(true);
  });

  it("preserves default, literal, relative, absolute, symlink and array roots", () => {
    const dir = fixture();
    expect(getRootDirs({ cwd: dir, settings: {} })).toEqual([dir]);
    expect(getRootDirs({ cwd: dir, settings: { next: { rootDir: 1 } } })).toEqual([dir]);
    const relativeRoot = relative(root, dir);
    for (const path of [dir, relativeRoot, relativeRoot.replace(/\//g, "\\"), join(dir, "linked"), join(dir, ".hidden")]) {
      expect(getRootDirs({ cwd: root, settings: { next: { rootDir: path } } })).toEqual([path.replace(/\\/g, "/")]);
    }
    expect(getRootDirs({ cwd: root, settings: { next: { rootDir: [dir, 42, null, dir] } } })).toEqual([dir, dir]);
    for (const path of [join(dir, "missing"), join(dir, "ordinary.txt")]) {
      expect(getRootDirs({ cwd: root, settings: { next: { rootDir: path } } })).toEqual([]);
    }
  });

  it.each(["", "apps/*/", "apps/**", "{apps,src}", "apps/?ne", "apps/[a-z]", "@(apps|src)", "!apps"])(
    "visibly rejects unsupported root %j", (pattern) => {
      expect(() => getRootDirs({ cwd: root, settings: { next: { rootDir: pattern } } })).toThrow(/literal directories/);
    },
  );

  it("rejects the original brace trigger and alternate malformed nesting in a bounded child", () => {
    const script = [
      'const { getRootDirs } = require("./tools/next-eslint/plugin/utils/get-root-dirs.js");',
      'for (const rootDir of ["{".repeat(3000)+"a,b"+"}".repeat(3000), "{".repeat(50000), "(".repeat(50000)]) {',
      'try { getRootDirs({cwd:process.cwd(),settings:{next:{rootDir}}}); process.exit(2); }',
      'catch (e) { if (!e.message.includes("literal directories") || e instanceof RangeError) process.exit(3); }',
      '}',
    ].join("\n");
    const child = spawnSync(process.execPath, ["-e", script], { cwd: root, timeout: 2000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  });

  it.each(["pages", "app"])("still reports internal anchors for the %s router", async (router) => {
    const dir = fixture();
    if (router === "app") {
      rmSync(join(dir, "pages"), { recursive: true });
      writeFileSync(join(dir, "app/page.js"), "export default function Page() { return null; }");
    } else {
      rmSync(join(dir, "app"), { recursive: true });
    }
    const settings = router === "pages" ? {} : { next: { rootDir: dir } };
    const eslint = new ESLint({
      cwd: dir, overrideConfigFile: true,
      overrideConfig: [{
        files: ["**/*.jsx"],
        languageOptions: { ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { "@next/next": plugin }, settings,
        rules: { "@next/next/no-html-link-for-pages": "error" },
      }],
    });
    const href = "/";
    const [bad] = await eslint.lintText('export default () => <a href="' + href + '">Internal</a>;', { filePath: join(dir, "example.jsx") });
    expect(bad.messages.some((message) => message.ruleId === "@next/next/no-html-link-for-pages")).toBe(true);
    const [good] = await eslint.lintText('export default () => <a href="https://example.com">External</a>;', { filePath: join(dir, "example.jsx") });
    expect(good.messages).toEqual([]);
  });
});
