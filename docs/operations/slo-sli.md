# SLO And SLI

MORROW is a stateful, consent-aware dependency. Operators should treat a failed
readiness check, migration-ledger mismatch, or tenant-boundary anomaly as a
traffic-stopping condition rather than a degraded success.

| Indicator | Target | Alert threshold | Measurement |
| --- | --- | --- | --- |
| Availability | 99.9% monthly | `/readyz` 5xx for 2 of 3 checks over 2 minutes | External synthetic probe |
| Write latency | 99% under 500 ms | 99% over 750 ms for 10 minutes | Edge or service metric, excluding client timeout |
| Read latency | 99% under 300 ms | 99% over 500 ms for 10 minutes | Edge or service metric |
| Consent/deletion correctness | 100% | Any unexpected 2xx/5xx for a synthetic revoke or deletion probe | Isolated synthetic tenant |
| Migration integrity | 100% | Any startup or readiness migration failure | Startup log and `/readyz` |

`/healthz` only shows that the Node process can answer HTTP. Load balancers and
deploy controllers must use `/readyz`; it checks the PostgreSQL connection and
the complete migration checksum ledger without requiring an end-user token.

Logs are structured JSON and must contain event names, correlation IDs, stable
error codes, and aggregate timing only. Never log memory content, consent
receipts, subject IDs, bearer tokens, SQL text, database URLs, or raw database
error messages. Retain operational logs no longer than the organization’s
approved diagnostic window; retain audit evidence according to the applicable
consent and legal retention policy.
