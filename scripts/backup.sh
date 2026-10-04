#!/usr/bin/env bash
# P0: backup harian PostgreSQL POS Inventory -> backups/ (retensi 14 hari).
# Cron contoh (jalankan `crontab -e`):
#   30 2 * * * cd /path/to/inventory_quot && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "[backup] .env tidak ditemukan" >&2
  exit 1
fi

# Baca koneksi dari .env (sederhana, tanpa dependency).
get_env() {
  sed -n "s/^$1=//p" .env | tr -d '"' | tail -1
}

DB_NAME="$(get_env POSTGRES_DB)"
DB_USER="$(get_env POSTGRES_USER)"
DB_PASS="$(get_env POSTGRES_PASSWORD)"
DB_HOST="$(get_env HOST)"
DB_PORT="$(get_env PORT)"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p backups
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="backups/${DB_NAME}_${STAMP}.dump"

echo "[backup] mulai ${DB_NAME}@${DB_HOST}:${DB_PORT} -> ${FILE}"

PGPASSWORD="${DB_PASS}" pg_dump \
  -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
  -Fc --no-owner --no-privileges \
  --exclude-table='public.idempotency_keys' \
  --exclude-table='public.refresh_tokens' \
  -f "${FILE}"

SIZE="$(du -h "${FILE}" | cut -f1)"
echo "[backup] selesai: ${FILE} (${SIZE})"

# Retensi: hapus backup lebih tua dari RETENTION_DAYS hari.
find backups -name '*.dump' -mtime "+${RETENTION_DAYS}" -delete
echo "[backup] retensi ${RETENTION_DAYS} hari diterapkan"
