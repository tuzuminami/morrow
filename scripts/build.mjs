import { mkdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";

const checkOnly = process.argv.includes("--check-only");

if (!checkOnly) {
  rmSync("dist", { force: true, recursive: true });
  mkdirSync("dist", { recursive: true });
  cpSync("src", join("dist", "src"), { recursive: true });
}

await import("../src/index.ts");

console.log(checkOnly ? "Syntax check passed." : "Build artifact prepared in dist/.");
