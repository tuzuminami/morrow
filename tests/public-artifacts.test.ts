import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const privateMarkers = [
  ["PRIVATE", "CONTROL", "DOCUMENT"].join(" "),
  ["PRIVATE", "OPERATOR", "MATERIAL"].join("_"),
  ["DO", "NOT", "COMMIT"].join("_")
];

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
