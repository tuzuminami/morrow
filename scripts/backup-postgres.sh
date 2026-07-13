#!/usr/bin/env bash
set -euo pipefail

: "${MORROW_DATABASE_URL:?MORROW_DATABASE_URL is required}"
: "${MORROW_BACKUP_FILE:?MORROW_BACKUP_FILE is required}"

backup_dir="$(dirname "$MORROW_BACKUP_FILE")"
backup_name="$(basename "$MORROW_BACKUP_FILE")"
tmp_file="${MORROW_BACKUP_FILE}.partial"

if [[ "$backup_name" != *.dump ]]; then
  echo "MORROW_BACKUP_FILE must end in .dump" >&2
  exit 1
fi

umask 077
mkdir -p "$backup_dir"
rm -f "$tmp_file"
trap 'rm -f "$tmp_file"' EXIT

pg_dump --dbname="$MORROW_DATABASE_URL" --format=custom --no-owner --no-privileges --file="$tmp_file"
mv "$tmp_file" "$MORROW_BACKUP_FILE"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$MORROW_BACKUP_FILE" > "${MORROW_BACKUP_FILE}.sha256"
else
  shasum -a 256 "$MORROW_BACKUP_FILE" > "${MORROW_BACKUP_FILE}.sha256"
fi

echo "MORROW backup created: ${MORROW_BACKUP_FILE}"
