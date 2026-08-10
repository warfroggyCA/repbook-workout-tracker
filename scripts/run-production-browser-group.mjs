import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const registry = JSON.parse(
  await readFile(new URL("./production-browser-groups.json", import.meta.url), "utf8"),
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const groupName = process.argv[2];
const group = registry.groups?.find((candidate) => candidate.name === groupName);

if (!group || !Array.isArray(group.scripts) || group.scripts.length === 0) {
  throw new Error(`Unknown or empty production browser group: ${String(groupName)}`);
}

for (const script of group.scripts) {
  if (typeof packageJson.scripts?.[script] !== "string") {
    throw new Error(`Production browser group ${groupName} references missing script ${script}`);
  }

  const env = { ...process.env };
  if (script === "test:e2e:compact-timer") {
    env.STAGE5_RUN_ID =
      env.STAGE5_RUN_ID ??
      `remediation-2026-07-31-stage5-r${env.GITHUB_RUN_ATTEMPT ?? "1"}`;
  }

  process.stdout.write(`\n=== ${groupName}: npm run ${script} ===\n`);
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script], {
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${script} terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exit(exitCode);
}
