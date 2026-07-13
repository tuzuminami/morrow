# Backup And Restore Drill

Run this drill at least quarterly with a non-production database and synthetic
data. A restore overwrites schema objects and is never a routine rollback tool.

## Backup

1. Use a dedicated backup credential with only the required PostgreSQL access.
2. Set an encrypted, access-controlled output location outside the repository.
3. Run:

   ```bash
   export MORROW_DATABASE_URL='postgresql://...'
   export MORROW_BACKUP_FILE='/secure-backups/morrow-2026-07-13.dump'
   ./scripts/backup-postgres.sh
   ```

4. Store the `.dump` and `.sha256` together in approved encrypted storage. Test
   that the checksum file verifies before considering the backup complete.

## Restore Drill

1. Stop MORROW traffic and restore only into an isolated target database.
2. Verify the backup checksum, then explicitly acknowledge the destructive step:

   ```bash
   export MORROW_RESTORE_CONFIRM=restore-morrow
   ./scripts/restore-postgres.sh
   ```

3. Run `pnpm run db:migrate`, start the service, and confirm `/readyz`.
4. Use synthetic requests to verify tenant isolation, consent enforcement,
   deletion, and subject export. Record duration, result, and correlation IDs
   without retaining memory content or credentials.

Do not restore a production backup into a developer machine or an unapproved
environment.
