#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TIMESCALE_URL:-}" ]]; then
  echo "Error: TIMESCALE_URL is not set." >&2
  echo "Set it in your environment or source your .env before running migrations." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../migrations"

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No migration files found in $MIGRATIONS_DIR"
  exit 0
fi

for file in "${files[@]}"; do
  echo "Running migration: $(basename "$file")"
  psql "$TIMESCALE_URL" -v ON_ERROR_STOP=1 -f "$file"
done

echo "Migrations complete"
