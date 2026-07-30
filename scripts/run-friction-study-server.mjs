import { spawn } from "node:child_process";
import { resolve } from "node:path";

const appCwd = process.env.STUDY_APP_CWD;
if (!appCwd) throw new Error("STUDY_APP_CWD is required.");

const child = spawn(
  process.execPath,
  ["scripts/run-e2e-server.mjs", "--production"],
  {
    cwd: resolve(appCwd),
    env: process.env,
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
