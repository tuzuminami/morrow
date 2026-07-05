import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const privateMarkers = [
  ["PRIVATE", "CONTROL", "DOCUMENT"].join(" "),
  ["PRIVATE", "OPERATOR", "MATERIAL"].join("_"),
  ["DO", "NOT", "COMMIT"].join("_")
];

interface PackManifest {
  readonly files: ReadonlyArray<{ readonly path: string }>;
}

test("TEST-CONTRACT-001 memory JSON schema is valid JSON and contains required fields", () => {
  const schema = JSON.parse(readFileSync("contracts/memory.schema.json", "utf8")) as {
    readonly required: readonly string[];
  };

  assert.ok(schema.required.includes("subjectId"));
  assert.ok(schema.required.includes("idempotencyKey"));
});

test("TEST-CONTRACT-002 deletion request JSON schema is valid JSON and idempotent", () => {
  const schema = JSON.parse(readFileSync("contracts/deletion-request.schema.json", "utf8")) as {
    readonly required: readonly string[];
  };

  assert.ok(schema.required.includes("memoryId"));
  assert.ok(schema.required.includes("reason"));
  assert.ok(schema.required.includes("idempotencyKey"));
});

test("TEST-BOUNDARY-001 public docs do not contain private control markers", () => {
  for (const file of ["README.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "openapi/openapi.yaml"]) {
    const content = readFileSync(file, "utf8");
    for (const marker of privateMarkers) {
      assert.equal(content.includes(marker), false, `${file} contains private marker ${marker}`);
    }
  }
});

test("TEST-PACKAGE-001 package dry-run excludes private and out-of-scope runtime material", () => {
  const output = execFileSync("pnpm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(output) as PackManifest | ReadonlyArray<PackManifest>;
  const pack: ReadonlyArray<PackManifest> = Array.isArray(parsed) ? parsed : [parsed];
  const files = pack.flatMap((item: PackManifest) => item.files.map((file: { readonly path: string }) => file.path));

  assert.ok(files.length > 0);
  for (const file of files) {
    assert.equal(privateMarkers.some((marker) => file.includes(marker)), false, `${file} contains a private marker`);
    assert.equal(/(^|\/)(README_PRIVATE|AGENTS_PRIVATE|CODEX_IMPLEMENTATION_HARNESS|CODEX_AI_COMPANION)/.test(file), false);
    assert.equal(/(^|\/)(01_BMA|02_StRS|03_SyRS|04_AD|05_DD|06_API_CONTRACT|07_VV_PLAN|08_TRACEABILITY|09_MVP_BACKLOG|10_RELEASE_CRITERIA)\.md$/.test(file), false);
    assert.equal(file.includes("persona-contract"), false, `${file} exposes Persona Contract runtime code`);
    assert.equal(file.startsWith("dist/tests/"), false, `${file} exposes test artifacts in the package`);
  }
});
