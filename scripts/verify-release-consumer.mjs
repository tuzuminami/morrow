import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const tarballOption = args.indexOf("--tarball");
const tarball = tarballOption === -1 ? undefined : args[tarballOption + 1];

if (tarball === undefined || !tarball.endsWith(".tgz")) {
  console.error("Consumer release check failed: --tarball must point to one package tarball.");
  process.exit(1);
}

const tarballPath = resolve(tarball);
if (!existsSync(tarballPath)) {
  console.error(`Consumer release check failed: package tarball is missing at ${tarballPath}`);
  process.exit(1);
}

const consumerDirectory = mkdtempSync(join(tmpdir(), "morrow-release-consumer-"));
try {
  writeFileSync(join(consumerDirectory, "package.json"), JSON.stringify({
    name: "morrow-release-consumer-check",
    private: true,
    type: "module"
  }, null, 2));
  execFileSync("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarballPath,
    "typescript@5.9.2",
    "@types/node@26.1.0"
  ], {
    cwd: consumerDirectory,
    stdio: "pipe"
  });
  execFileSync(process.execPath, ["--input-type=module", "--eval", [
    'import("@tuzuminami/morrow").then((module) => {',
    'if (typeof module.InMemoryMemoryEngine !== "function") process.exit(1);',
    '})'
  ].join("")], { cwd: consumerDirectory, stdio: "pipe" });

  writeFileSync(join(consumerDirectory, "consumer.ts"), [
    'import { InMemoryMemoryEngine, type MorrowPrincipal } from "@tuzuminami/morrow";',
    "const principal: MorrowPrincipal = {",
    '  tenantId: "tenant_consumer",',
    '  actorId: "actor_consumer",',
    '  scopes: ["memory:read"],',
    '  subjectId: "subject_consumer"',
    "};",
    "void principal;",
    "void InMemoryMemoryEngine;"
  ].join("\n"));
  execFileSync(join(consumerDirectory, "node_modules", ".bin", "tsc"), [
    "--noEmit",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "consumer.ts"
  ], { cwd: consumerDirectory, stdio: "pipe" });

  for (const command of ["morrow-migrate", "morrow-server"]) {
    const bin = join(consumerDirectory, "node_modules", ".bin", command);
    if (!existsSync(bin) || !lstatSync(bin).isSymbolicLink()) {
      throw new Error(`expected installed public binary ${command}`);
    }
  }

  console.log(`Consumer release check passed for ${basename(tarballPath)}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Consumer release check failed: ${message}`);
  process.exitCode = 1;
} finally {
  rmSync(consumerDirectory, { force: true, recursive: true });
}
