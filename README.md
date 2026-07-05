# MORROW

MORROW is an early-stage Consent-Aware Memory Engine for AI applications. It
stores and retrieves typed memories only when tenant, subject, purpose, policy,
consent, and retention constraints permit it.

The repository is built as a commercial-friendly OSS foundation: explicit
contracts, fail-closed behavior, tenant boundaries, append-only audit evidence,
and adapter-ready architecture come before UI or provider integrations.

## Status

This is a v0.1 bootstrap MVP. It includes:

- typed memory registration for `episodic`, `fact`, `preference`,
  `relationship`, and `instruction`
- consent receipt registration and enforcement before persistence/retrieval
- retention rules and expiry filtering
- tenant, subject, purpose, and policy-scoped retrieval
- idempotent memory writes and revocations
- append-only audit events with actor, reason, and correlation ID
- deterministic contract compilation utilities retained as a small companion
  module
- OpenAPI 3.1 draft, JSON Schema, PostgreSQL migration, Docker Compose, CI, and
  repository private-boundary guard

Persistent PostgreSQL adapters and HTTP transport are the next implementation
slice; the current executable engine uses an in-memory adapter for deterministic
tests and local demos.

## Quick Start

```bash
pnpm install
pnpm run verify
pnpm run demo
```

`pnpm run demo` registers retention, consent, and one synthetic memory, then
queries it under the same tenant and purpose.

For the PostgreSQL schema preview:

```bash
docker compose up
```

The compose file initializes PostgreSQL with the migration under `migrations/`.

## Public API Direction

The draft OpenAPI contract lives in `openapi/openapi.yaml` and currently covers:

- `POST /v1/consent-receipts`
- `POST /v1/retention-rules`
- `POST /v1/memories`
- `POST /v1/memories/query`
- `POST /v1/memories/{memoryId}/revoke`

The package exports the in-memory engine, domain types, typed errors, and the
deterministic contract compiler utilities from `src/index.ts`.

To run the dependency-free API locally:

```bash
pnpm start
```

## Safety Properties

- Missing consent fails closed before memory persistence.
- Wrong-tenant retrieval returns no cross-tenant data.
- Wrong-tenant mutation is denied.
- Expired retention removes memories from retrieval and export.
- Repeated idempotency keys do not duplicate side effects.
- Revocation clears retrievable content and records audit evidence.
- Private operator material and private requirement documents are blocked by
  `.gitignore`, `.dockerignore`, `.npmignore`, and `scripts/check-private-boundary.mjs`.

## Limitations

- HTTP transport is not implemented yet.
- PostgreSQL schema is present, but the runtime storage adapter is still
  in-memory.
- Strict TypeScript build is enabled, with JavaScript and declaration output
  emitted under `dist/`.

## License

Apache-2.0
