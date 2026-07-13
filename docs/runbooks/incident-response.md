# Incident Response

## First 30 Minutes

1. Declare an incident owner and create a time-stamped event log with no memory
   content, credentials, or raw database output.
2. Classify the event: availability, migration integrity, possible tenant
   exposure, consent/deletion failure, or supply-chain concern.
3. If data boundaries are uncertain, remove affected instances from traffic and
   pause writes. Preserve audit metadata and deployment identifiers.
4. Rotate exposed credentials through the secret manager. Do not paste them into
   issues, chat transcripts, or shell history.
5. Record affected versions, deployment IDs, time window, and correlation IDs.

## Migration Integrity

When startup or `/readyz` reports a migration problem, keep the instance out of
traffic. Compare the packaged migration files with the ledger and release
commit. Never edit an applied migration or manually alter `schema_migrations`.
Restore a verified backup only when data recovery is required; otherwise ship a
new forward migration and validate it in an isolated database first.

## Recovery And Follow-up

Recover with a reviewed change, validate `/readyz`, run synthetic tenant and
consent checks, then reopen traffic gradually. Open a public issue only after
secrets and affected data are excluded. Security disclosures follow
`SECURITY.md`; publish a post-incident summary with cause, impact, remediation,
and regression coverage.
