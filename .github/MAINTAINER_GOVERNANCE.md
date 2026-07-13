# Maintainer Governance

MORROW is maintained in the open as consent-aware memory infrastructure. `CODEOWNERS` assigns the current maintainer for source, contracts, migrations, workflow, releases, and security-sensitive paths.

## Required Pull Request Evidence

Every change uses the pull request template and the exact commit must pass `verify`. Changes that affect consent, retention, tenant boundaries, deletion/export, audit evidence, or PostgreSQL migrations require explicit compatibility, recovery, and test evidence. Use synthetic data only. Security vulnerabilities follow `SECURITY.md`, not public issues.

## Default Branch Baseline

Repository administrators configure `main` with these protections:

1. Require pull requests before merging; do not allow direct pushes.
2. Require the `verify` status check and require branches to be up to date.
3. Require all review conversations to be resolved.
4. Block force pushes and branch deletion, including for administrators.
5. Use `CODEOWNERS` to assign ownership for consent, migration, workflow, release, and public-boundary paths. For this single-maintainer repository, record independent correctness and security review evidence before release instead of requiring an unavailable second approver.

Verify the live setting with:

```bash
gh api repos/tuzuminami/morrow/branches/main/protection
```

## Release And Disclosure Baseline

Release only from green `main` commits merged through pull requests. Do not rewrite a public tag; publish a corrective patch release instead. Supply-chain evidence and operator recovery requirements are defined with the release and operations issues, not bypassed by direct publication.

MORROW accepts private vulnerability reports through GitHub private vulnerability reporting or direct contact with the repository owner. Do not publish exploit details, consent receipts, production memories, database dumps, access tokens, or private operator material.
