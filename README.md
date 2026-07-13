# MORROW
<p align="center">
  <img src="./docs/brand/banner.svg" width="100%" alt="MORROW — Consent-Aware Memory" />
</p>

<p align="center"><strong>Part of the Tuzuminami AI Systems reference architecture.</strong><br />Independent packages, designed to compose — without claiming runtime package dependencies.</p>

> **System role:** Remember only with consent. MORROW keeps memory bounded by purpose, policy, consent, retention, and tenant scope.

## Ecosystem reference architecture

The map below describes an **intended composition**, not current npm/package dependencies. Every repository remains independently usable and independently versioned. An application verifies a VEIL decision before it invokes RELAY; this does not indicate direct VEIL-to-RELAY SDK integration.

```mermaid
flowchart LR
  ASTER["ASTER<br/>Persona contracts"] -->|"compiled artifact reference"| DRIFT["DRIFT<br/>Scenarios & replay"]
  MORROW["MORROW<br/>Consent-aware memory"] --> APP["AI application"]
  TETHER["TETHER<br/>Relationship state"] --> APP
  APP -->|"action context"| VEIL["VEIL<br/>Policy decision"]
  APP -->|"model request after decision verification"| RELAY["RELAY<br/>Inference gateway"]
  RELAY --> PROVIDER["Model / tool provider"]
  PULSE["PULSE<br/>Evaluation harness"] -. "evaluates HTTP targets" .-> APP
  PULSE -.-> VEIL
  PULSE -.-> RELAY
  classDef policy fill:#1D2645,stroke:#6FF6C8,color:#FFFFFF
  classDef relationship fill:#3C144C,stroke:#E82973,color:#FFFFFF
  classDef gateway fill:#113A48,stroke:#31D2C9,color:#FFFFFF
  classDef eval fill:#3F215A,stroke:#E8A1FF,color:#FFFFFF
  classDef memory fill:#3D3A20,stroke:#EFD576,color:#FFFFFF
  classDef orchestration fill:#1D3942,stroke:#6DD9DF,color:#FFFFFF
  classDef persona fill:#3B1E14,stroke:#FFC79F,color:#FFFFFF
  class VEIL policy
  class TETHER relationship
  class RELAY gateway
  class PULSE eval
  class MORROW memory
  class DRIFT orchestration
  class ASTER persona
```

| System | What it contributes |
| --- | --- |
| [VEIL](https://github.com/tuzuminami/veil) | Fail-closed policy decisions and receipts before agent actions. |
| [TETHER](https://github.com/tuzuminami/tether) | Explicit, explainable relationship state. |
| [RELAY](https://github.com/tuzuminami/relay) | Tenant-aware inference routing and provider enforcement. |
| [PULSE](https://github.com/tuzuminami/pulse) | Regression evaluation for HTTP targets and release evidence. |
| [MORROW](https://github.com/tuzuminami/morrow) | Consent, purpose, retention, and revocation-aware memory. |
| [DRIFT](https://github.com/tuzuminami/drift) | Deterministic scenario/session orchestration and replay. |
| [ASTER](https://github.com/tuzuminami/aster) | Versioned persona contracts compiled into portable artifacts. |



MORROW is an early-stage Consent-Aware Memory Engine for AI applications. It
stores, retrieves, revokes, expires, deletes, and exports typed memories only
when tenant, subject, purpose, policy, consent, and retention constraints permit
it.

The repository is built as a commercial-friendly OSS foundation: explicit
contracts, fail-closed behavior, tenant boundaries, append-only audit evidence,
and adapter-ready architecture come before UI or provider integrations.

## Status

MORROW V1.0.0 is a PostgreSQL-backed consent-aware memory runtime. It includes:

- typed memory registration for `episodic`, `fact`, `preference`,
  `relationship`, and `instruction`
- consent receipt registration and enforcement before persistence/retrieval
- retention rules and expiry filtering
- tenant, subject, type, purpose, and policy-scoped retrieval
- idempotent memory writes and revocations
- deletion-request and subject-export HTTP routes
- append-only audit events with actor, reason, and correlation ID
- PostgreSQL runtime for the complete public API, with transaction-scoped
  idempotency and audit writes
- migration runner with a checksum ledger and startup readiness check
- an explicit authenticator port; verified identity is the only source of
  tenant, actor, and scope authority
- OpenAPI 3.1 contract, JSON Schema, Docker Compose, CI with PostgreSQL E2E,
  a repository private-boundary guard, and release SBOM/provenance evidence

## Quick Start

```bash
pnpm install
pnpm run verify
pnpm run demo
```

`pnpm run demo` registers retention, consent, and one synthetic memory, then
queries it under the same tenant and purpose.

For a local PostgreSQL database, set a non-committed password and start the
database:

```bash
export MORROW_POSTGRES_PASSWORD='choose-a-local-dev-password'
docker compose up
```

Then apply the forward-only migrations:

```bash
export MORROW_DATABASE_URL='postgresql://morrow:choose-a-local-dev-password@localhost:54329/morrow'
pnpm run db:migrate
```

MORROW records every applied migration with a SHA-256 checksum. The server will
refuse to start when a migration is missing or has changed after application.
`001_initial.down.sql` remains a development recovery aid; production rollbacks
should use a new forward migration rather than editing applied history.
V1 creates a fresh database only: an existing pre-ledger schema is rejected
rather than being silently stamped as compatible. Export or archive that data,
then initialize a fresh V1 database before migration.

## Public API Direction

The OpenAPI 3.1 contract lives in `openapi/openapi.yaml` and covers:

- `POST /v1/consent-receipts`
- `POST /v1/retention-rules`
- `POST /v1/memories`
- `POST /v1/memories/query`
- `POST /v1/memories/{memoryId}/revoke`
- `POST /v1/deletion-requests`
- `GET /v1/subjects/{subjectId}/export`

The package exports the domain engine, async runtime port, PostgreSQL runtime,
HTTP dispatch utilities, typed errors, and storage ports from `src/index.ts`.

MORROW does not implement Persona Contract compilation, relationship scoring,
scenario orchestration, LLM provider routing, policy PDP behavior, or an
evaluation harness. Persona-like and relationship-like facts can be stored as
typed memory data when the same consent, retention, tenant, and policy
constraints allow it.

To run the server, provide an external ES module that exports a verified
`authenticator`. The module must map an `Authorization` value to a trusted
tenant ID, actor ID, and scopes; MORROW deliberately does not ship a fake
header-to-identity adapter.

```js
// ./local-auth.mjs -- development example only; do not commit real credentials.
export const authenticator = {
  async authenticate(authorization) {
    if (authorization !== process.env.MORROW_DEV_BEARER) return undefined;
    return {
      tenantId: "tenant_local",
      actorId: "developer_local",
      scopes: ["retention:write", "consent:write", "memory:write", "memory:read", "memory:delete", "memory:export"]
    };
  }
};
```

Start it only after `pnpm run db:migrate` succeeds:

```bash
export MORROW_AUTH_MODULE=./local-auth.mjs
pnpm start
```

`X-Tenant-Id` is only an optional assertion: a different value is rejected and
an absent value never selects a tenant. `X-Morrow-Scopes` is not recognized.
The server binds to loopback by default. To bind a non-loopback `HOST`, run it
behind a trusted TLS terminator and set `MORROW_TLS_TERMINATED=true`; direct
plain-HTTP bearer-token exposure is intentionally rejected.

## Safety Properties

- Missing consent fails closed before memory persistence.
- Missing, invalid, or failing authentication fails closed before every
  protected operation.
- Wrong-tenant retrieval and subject export return no cross-tenant data.
- Wrong-tenant mutation is denied.
- Expired retention removes memories from retrieval and export.
- Repeated idempotency keys do not duplicate side effects.
- Conflicting idempotency-key reuse fails closed.
- Revocation clears retrievable content and records audit evidence.
- Deletion requests revoke retrievable content and are idempotent.
- SQL storage queries include tenant, subject, type, purpose, policy, status,
  and TTL predicates at the database boundary.
- PostgreSQL migrations are checksum-verified and protected by an advisory lock;
  the server refuses stale schema state.
- Requests are limited to 1 MiB and persisted memory content to 16 KiB. Queries
  and subject exports return at most 100 memories; larger exports fail explicitly until cursor/stream export
  support is introduced.
- Private operator material and private requirement documents are blocked by
  `.gitignore`, `.dockerignore`, `.npmignore`, and `scripts/check-private-boundary.mjs`.

## Boundaries

- MORROW supplies the consent-aware memory decision and persistence boundary;
  callers supply verified identity through `MorrowAuthenticator`.
- Vector search, plugin host runtime, background workers, and SDKs are
  intentionally outside V1. The packaged `morrow-migrate` and `morrow-server`
  commands cover database migration and server startup only.
- The in-memory runtime remains available for deterministic unit tests and
  embedded evaluation, while the executable server uses PostgreSQL only.
- Strict TypeScript emits JavaScript and declarations under `dist/`.

## License

Apache-2.0

## Release Evidence

Each post-V1 release is built from a verified `main` tag and includes a
CycloneDX SBOM, SHA-256 checksums, and GitHub artifact attestations. See
[docs/release.md](./docs/release.md) for the release procedure and consumer
verification commands.
