# Changelog

## 0.2.0 - 2026-07-05

### Added

- Idempotent deletion-request flow that revokes retrievable memory content and
  records append-only audit evidence.
- Subject export API route for active, unexpired tenant-scoped memories.
- Dependency-free PostgreSQL memory-store foundation with explicit SQL
  transaction provider, tenant-scoped query predicates, and audit writes.
- Deletion-request JSON Schema and PostgreSQL migration table.

### Changed

- OpenAPI contract now covers deletion requests, subject export, and revoke
  request bodies.
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
