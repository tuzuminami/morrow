#!/usr/bin/env bash
set -euo pipefail

: "${MORROW_DATABASE_URL:?MORROW_DATABASE_URL is required}"
: "${MORROW_BACKUP_FILE:?MORROW_BACKUP_FILE is required}"

if [[ "${MORROW_RESTORE_CONFIRM:-}" != "restore-morrow" ]]; then
  echo "Set MORROW_RESTORE_CONFIRM=restore-morrow to acknowledge destructive restore." >&2
  exit 1
fi

if [[ ! -f "$MORROW_BACKUP_FILE" ]]; then
  echo "Backup file does not exist: $MORROW_BACKUP_FILE" >&2
  exit 1
fi

if [[ -f "${MORROW_BACKUP_FILE}.sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check "${MORROW_BACKUP_FILE}.sha256"
  else
    shasum -a 256 --check "${MORROW_BACKUP_FILE}.sha256"
  fi
fi

pg_restore --dbname="$MORROW_DATABASE_URL" --clean --if-exists --no-owner --no-privileges "$MORROW_BACKUP_FILE"
echo "MORROW restore completed. Run pnpm run db:migrate and verify /readyz before reopening traffic."
