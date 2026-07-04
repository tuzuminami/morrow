# MORROW

MORROW is an early-stage, consent-aware memory control foundation for AI
applications.

The project is intended to help applications manage remembered information with
explicit consent, retention boundaries, auditability, and tenant isolation. It is
being shaped for model-agnostic systems such as AI companions, support agents,
learning tools, games, and business assistants.

## Status

This repository currently contains the public project starting point only. The
initial implementation, API contracts, tests, and contribution guides will be
added incrementally.

## Scope

- Consent-aware memory capture, retrieval, update, and deletion
- Multi-tenant safety boundaries
- Auditable state changes
- Provider-agnostic adapters for external model and storage integrations
- Commercial-friendly open source distribution

## Non-goals

- Built-in identity verification
- Indefinite full conversation archiving as the default behavior
- Medical or psychological diagnosis memory models

## Planned Technical Direction

- TypeScript with strict type checking
- Node.js LTS and pnpm
- PostgreSQL for durable state
- OpenAPI 3.1 and JSON Schema at system boundaries
- Unit, integration, contract, and authorization tests

## License

Apache-2.0
