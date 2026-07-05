# Changelog

## 0.1.0 - Unreleased

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
