# MORROW

MORROW is an early-stage foundation for explicit, versioned, tenant-safe AI
state. This repository currently includes a small deterministic contract
compilation slice: create a versioned Persona Contract, publish it immutably, and
compile it into a reproducible `CompiledBundle`.

## Status

This is an MVP bootstrap. The current implementation is intentionally small and
dependency-light:

- TypeScript source executed by Node.js type stripping
- deterministic canonical JSON hashing
- immutable published versions
- tenant checks before compilation
- fail-closed plugin reference validation
- append-only in-memory audit evidence
- private-boundary guard for public repository hygiene

Persistent storage and HTTP/OpenAPI contracts are the next implementation step.

## Quick Start

```bash
pnpm install
pnpm run verify
pnpm run demo
```

The demo prints a compiled content hash and audit event count for a synthetic
contract.

## Public API Surface

The package exports:

- `InMemoryPersonaStore`
- `PersonaCompiler`
- `validatePersonaContract`
- `MorrowError`
- public TypeScript types for contracts, versions, bundles, audit events, and
  tenant context

## Safety Notes

- Published versions are immutable.
- Tenant mismatch fails before bundle compilation.
- Unknown plugin references fail closed.
- The compiler uses canonical JSON and SHA-256 so the same published contract and
  compiler version produce the same content hash.
- This repository intentionally excludes local operator material, private
  planning documents, private fixtures, and raw conversation data from public
  artifacts.

## Limitations

- Storage is currently in-memory for the bootstrap slice.
- There is no HTTP transport yet.
- TypeScript is executed with Node.js type stripping in this offline-friendly MVP;
  full `tsc --noEmit` strict checking will be added with the dependency toolchain.

## License

Apache-2.0
