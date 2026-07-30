import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

const forbidden =
  /(?:describe|it|test)\s*\.\s*(?:skip|only|todo|fixme)\s*\(|\b(?:xdescribe|xit|xtest)\s*\(/g;
const findings = [];

for (const file of await testFiles("tests")) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(forbidden)) {
    const line = source.slice(0, match.index).split("\n").length;
    findings.push(`${file}:${line}: ${match[0].trim()}`);
  }
}

if (findings.length) {
  throw new Error(
    `Skipped, focused, todo, or fixme tests are forbidden:\n${findings.join("\n")}`
  );
}

process.stdout.write("All checked-in tests are active.\n");
