# Changelog

## 1.0.2 - 2026-08-01

- Make cross-subject memory mutation responses indistinguishable from missing resources.
- Align the documented and enforced subject export limit at 100 records.
- Add PostgreSQL E2E coverage for subject authority, delegated access expiry, idempotency isolation, and legacy idempotency rows.

## 1.0.1 - 2026-08-01

### Security

- Bind every consent and memory operation to the authenticated subject claim or an explicit,
  scope-limited, unexpired subject delegation.
- Enforce subject authorization inside the in-memory and PostgreSQL runtimes before idempotency
  replay, with no delegation-issuance endpoint in the public API.
- Add PostgreSQL idempotency subject evidence for new operations and fail closed for mismatched
  subject access.

## Unreleased

### Added

- A guarded release-evidence workflow that creates CycloneDX SBOMs, package
  checksums, and GitHub provenance/SBOM attestations before publishing a new
  release.
- Weekly Dependabot updates for npm dependencies and GitHub Actions, validated
  by the repository `verify` gate.

## 1.0.0 - 2026-07-12

### Added

- PostgreSQL-backed runtime for every public memory operation, including
  retention, consent, storage, query, revocation, deletion requests, and export.
- Transactional migration runner with an advisory lock, checksum ledger, and
  fail-closed startup check for unapplied or modified migrations.
- Authenticator port for verified tenant, actor, and scopes; the HTTP layer no
  longer accepts tenant or scope authority from request headers.
- PostgreSQL HTTP E2E coverage in GitHub Actions using a disposable service
  container.

### Changed

- The executable server now requires a PostgreSQL connection and an explicit
  authenticator module. It refuses to start with missing migration state.
- V1 refuses automatic adoption of an existing database without a migration
  ledger, preventing an unknown legacy schema from being stamped as compatible.
- Memory content is capped at 16 KiB in the runtime and PostgreSQL schema;
  query and export responses are bounded to protect shared-process availability.
- Package metadata, OpenAPI version, and release gates are aligned to V1.0.0.

### Security

- V1 fails closed when authentication is missing or fails, rejects tenant-header
  spoofing, and keeps idempotency, audit, and mutation work transaction-scoped.

## 0.2.0 - 2026-07-05

### Added

- Idempotent deletion-request flow that revokes retrievable memory content and
  records append-only audit evidence.
- Subject export API route for active, unexpired tenant-scoped memories.
- Dependency-free PostgreSQL memory-store foundation with explicit SQL
  transaction provider, tenant-scoped query predicates, and audit writes.
- Deletion-request JSON Schema and PostgreSQL migration table.
- PostgreSQL rollback migration and migration contract check in `pnpm run verify`.

### Changed

- OpenAPI contract now covers deletion requests, subject export, and revoke
  request bodies.
- PostgreSQL memory inserts now enforce idempotency-key reuse with request-hash
  conflict detection.
- Docker Compose now mounts only the up migration during database initialization.
- Private-boundary checks now include untracked, non-ignored files.
- Package version updated to `0.2.0`.

### Known Limitations

- Runtime API storage still defaults to in-memory storage; the PostgreSQL port is
  ready for `pg.Pool`-compatible wiring but this release does not bundle `pg`.
- Authentication remains a development header adapter.
- Vector search, plugin host runtime, workers, SDK, and CLI remain planned
  follow-up work.

## 0.1.0 - 2026-07-05

### Added

- Consent-aware memory core with consent, retention, scoped query, revocation,
  export, idempotency, and append-only audit behavior.
- Dependency-free HTTP dispatch/API surface for the primary memory flow.
- OpenAPI 3.1 draft, JSON Schema, PostgreSQL schema migration, Docker Compose,
  CI workflow, and public security/contribution documents.
- Strict TypeScript build with JavaScript and declaration output under `dist/`.
- Repository private-boundary guard for accidental private material exposure.

### Known Limitations

- Runtime storage adapter is currently in-memory; PostgreSQL schema exists but is
  not wired into the HTTP runtime yet.
- Authentication is a development header adapter, not production identity
  provider integration.
