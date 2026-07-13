# Consent Or Deletion Failure

Treat any evidence that a memory survived revocation, deletion, retention
expiry, or a tenant boundary as a potential security incident.

1. Stop affected write paths and remove affected instances from traffic.
2. Preserve only safe evidence: release SHA, deployment ID, correlation IDs,
   aggregate counts, and timestamps. Do not copy memory content, subject IDs,
   consent receipts, or tokens into tickets.
3. Scope the impact with a privileged, audited query in the approved incident
   environment. Keep the original data boundary intact for investigation.
4. Revoke access credentials if identity, tenant, or authorization behavior is
   implicated. Confirm migration ledger integrity before data repair.
5. Repair through a reviewed, idempotent operation or forward migration. Verify
   with a synthetic tenant that revoked/deleted memories are absent from query
   and export results.
6. Notify affected stakeholders through the organization’s approved privacy and
   incident process. Security vulnerabilities follow `SECURITY.md`.
