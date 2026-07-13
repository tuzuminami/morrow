import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("TEST-MIGRATION-001 rollback migration is present for package consumers", () => {
  const rollback = readFileSync("migrations/001_initial.down.sql", "utf8");

  assert.match(rollback, /DROP TABLE IF EXISTS memories/);
  assert.match(rollback, /DROP TABLE IF EXISTS idempotency_keys/);
  assert.match(rollback, /DROP TABLE IF EXISTS audit_events/);
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
  assert.ok(files.includes("migrations/001_initial.sql"));
  assert.ok(files.includes("migrations/001_initial.down.sql"));
  assert.ok(files.includes("docs/operations/slo-sli.md"));
  assert.ok(files.includes("docs/runbooks/backup-restore.md"));
  assert.ok(files.includes("scripts/backup-postgres.sh"));
  assert.ok(files.includes("scripts/restore-postgres.sh"));
  for (const file of files) {
    assert.equal(privateMarkers.some((marker) => file.includes(marker)), false, `${file} contains a private marker`);
    assert.equal(/(^|\/)(README_PRIVATE|AGENTS_PRIVATE|CODEX_IMPLEMENTATION_HARNESS|CODEX_AI_COMPANION)/.test(file), false);
    assert.equal(/(^|\/)(01_BMA|02_StRS|03_SyRS|04_AD|05_DD|06_API_CONTRACT|07_VV_PLAN|08_TRACEABILITY|09_MVP_BACKLOG|10_RELEASE_CRITERIA)\.md$/.test(file), false);
    assert.equal(file.includes("persona-contract"), false, `${file} exposes Persona Contract runtime code`);
    assert.equal(file.startsWith("dist/tests/"), false, `${file} exposes test artifacts in the package`);
  }
});

test("TEST-RELEASE-001 release evidence requires a matching tag, CycloneDX SBOM, package tarball, and checksums", () => {
  const artifacts = mkdtempSync(join(tmpdir(), "morrow-release-evidence-"));
  try {
    writeFileSync(join(artifacts, "tuzuminami-morrow-1.0.0.tgz"), "synthetic package artifact");
    writeFileSync(join(artifacts, "morrow.cdx.json"), JSON.stringify({
      bomFormat: "CycloneDX",
      metadata: { component: { group: "@tuzuminami", name: "morrow", version: "1.0.0" } }
    }));

    const output = execFileSync("node", [
      "scripts/check-release-evidence.mjs",
      "--tag", "v1.0.0",
      "--artifacts", artifacts
    ], { encoding: "utf8" });

    assert.match(output, /Release evidence check passed/);
    assert.match(readFileSync(join(artifacts, "SHA256SUMS"), "utf8"), /morrow\.cdx\.json/);
    assert.throws(() => execFileSync("node", [
      "scripts/check-release-evidence.mjs",
      "--tag", "v1.0.1",
      "--artifacts", artifacts
    ], { encoding: "utf8", stdio: "pipe" }));
  } finally {
    rmSync(artifacts, { force: true, recursive: true });
  }
});

test("TEST-OPS-001 restore refuses to run without the matching checksum sidecar", () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-restore-"));
  const backup = join(directory, "morrow.dump");
  try {
    writeFileSync(backup, "synthetic backup");
    assert.throws(() => execFileSync("bash", ["scripts/restore-postgres.sh"], {
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        MORROW_DATABASE_URL: "postgresql://example.invalid/morrow",
        MORROW_BACKUP_FILE: backup,
        MORROW_RESTORE_CONFIRM: "restore-morrow"
      }
    }));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
