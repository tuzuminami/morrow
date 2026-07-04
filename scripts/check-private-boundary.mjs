import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const prohibitedPathPatterns = [
  /(^|\/)CODEX(_AI_COMPANION_OSS)?_IMPLEMENTATION_HARNESS\.md$/,
  /(^|\/)AGENTS\.private\.md$/,
  /(^|\/)(00_GLOSSARY|01_BMA|02_StRS|03_SyRS|04_AD|05_DD|06_API_CONTRACT|07_VV_PLAN|08_TRACEABILITY|09_MVP_BACKLOG|10_RELEASE_CRITERIA)\.md$/,
  /(^|\/)(private-ai-control-plane|\.private|\.codex-private|evidence-private|private-fixtures)(\/|$)/,
  /(^|\/)\.env(\..*)?$/,
  /\.(sqlite|sqlite3|db|dump|jsonl)$/i
];

const prohibitedMarkers = [
  ["PRIVATE", "SPECIFICATION", "DO", "NOT", "COMMIT"].join("_"),
  ["PRIVATE", "OPERATOR", "MATERIAL"].join("_"),
  ["DO", "NOT", "COMMIT", "OR", "PUBLISH"].join("_")
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function listFiles(args) {
  const output = git(args);
  return output.length === 0 ? [] : output.split("\n").filter(Boolean);
}

const files = new Set([
  ...listFiles(["ls-files"]),
  ...listFiles(["diff", "--cached", "--name-only"])
]);

const failures = [];

for (const file of files) {
  if (file === ".env.example") {
    continue;
  }

  if (prohibitedPathPatterns.some((pattern) => pattern.test(file))) {
    failures.push(`prohibited path: ${file}`);
    continue;
  }

  try {
    const content = readFileSync(file, "utf8");
    const marker = prohibitedMarkers.find((value) => content.includes(value));
    if (marker !== undefined) {
      failures.push(`private marker ${marker} found in ${file}`);
    }
  } catch (error) {
    failures.push(`cannot inspect ${file}: ${String(error)}`);
  }
}

if (failures.length > 0) {
  console.error("Private boundary check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Private boundary check passed for ${files.size} tracked/staged files.`);
