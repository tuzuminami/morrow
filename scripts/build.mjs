import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const checkOnly = process.argv.includes("--check-only");

if (!checkOnly) {
  rmSync("dist", { force: true, recursive: true });
}

execFileSync("tsc", ["-p", "tsconfig.json", ...(checkOnly ? ["--noEmit"] : [])], {
  stdio: "inherit"
});
