# Production Runbook

## Deploy

1. Set `MORROW_DATABASE_URL` and `MORROW_AUTH_MODULE` through the deployment
   platform’s secret mechanism. Do not place either in repository files or logs.
2. Run `pnpm run db:migrate` as a single deployment step. It takes an advisory
   lock and refuses unknown, missing, or checksum-mismatched migrations.
3. Start `morrow-server` with a loopback bind, or set
   `MORROW_TLS_TERMINATED=true` only behind a trusted TLS terminator.
4. Wait for `/readyz` before sending traffic. `/healthz` is liveness only.
5. On shutdown, stop accepting traffic first, send `SIGTERM`, and allow the
   configured `MORROW_SHUTDOWN_TIMEOUT_MS` (default 30 seconds) to drain.

## Alert Triage

- `/healthz` fails: restart or replace the process; investigate platform logs.
- `/readyz` fails while `/healthz` passes: remove the instance from traffic and
  check PostgreSQL reachability, credentials, and migration-ledger state.
- Migration checksum mismatch: do not edit migration history or stamp the
  ledger. Follow [migration recovery](./incident-response.md#migration-integrity).
- Tenant, consent, deletion, or export anomaly: stop affected writes and follow
  [consent and deletion failure](./consent-deletion-failure.md).
