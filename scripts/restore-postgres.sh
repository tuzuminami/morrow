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

checksum_file="${MORROW_BACKUP_FILE}.sha256"
if [[ ! -f "$checksum_file" ]]; then
  echo "Checksum file does not exist: $checksum_file" >&2
  exit 1
fi

if [[ "$(wc -l < "$checksum_file" | tr -d ' ')" != "1" ]]; then
  echo "Checksum file must contain exactly one backup digest." >&2
  exit 1
fi

checksum_target="$(awk 'NR == 1 { sub(/^[^[:space:]]+[[:space:]]+\\*?/, ""); print }' "$checksum_file")"
if [[ "$checksum_target" != "$MORROW_BACKUP_FILE" ]]; then
  echo "Checksum file does not name the requested backup." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --check "$checksum_file"
else
  shasum -a 256 --check "$checksum_file"
fi

pg_restore --dbname="$MORROW_DATABASE_URL" --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error "$MORROW_BACKUP_FILE"
echo "MORROW restore completed. Run pnpm run db:migrate and verify /readyz before reopening traffic."
