# POS Inventory API — Deployment & Operasional

Backend POS inventory (API only, tanpa frontend). PostgreSQL 16 remote, Express + TypeScript.

## Menjalankan

```bash
npm install
npm run migrate          # baseline + 0002 opex + 0003 hardening (idempotent)
npm run seed             # user owner/kasir1 + payment methods
npm run build && npm start   # atau: npm run dev (tsx watch)
```

- Swagger: `http://localhost:3000/api-docs`
- Health: `http://localhost:3000/health`

## Go-live checklist (P0)

1. **Amankan database** (paling penting — DB saat ini terekspos internet):
   - Firewall/Security Group: izinkan port 5432 HANYA dari IP server API.
   - Aktifkan SSL di PostgreSQL (`ssl=on` + sertifikat), lalu set `DB_SSL=true` di `.env`.
   - Ganti password DB default; jangan commit `.env`.
2. **Role** kini tersimpan di kolom `user_account.role` (migration 0003) — tambah/kelola user via DB; `.env OWNER_USERNAMES` hanya fallback awal.
3. **Backup harian**:
   ```bash
   ./scripts/backup.sh                       # tes manual
   crontab -e
   30 2 * * * cd /path/to/inventory_quot && ./scripts/backup.sh >> backups/backup.log 2>&1
   ```
4. **Data uji**: `npm run mark-test-data` — menandai transaksi e2e `is_test=true` agar tidak mencemari laporan (lihat dengan `?include_test=true`).
5. **Process manager**: `pm2 start ecosystem.config.js && pm2 save && pm2 startup`.
6. `NODE_ENV=production`, JWT_SECRET kuat & unik, gunakan reverse proxy HTTPS (nginx/caddy) di depan app.

## Operasional harian

- Owner: `GET /reports/dashboard`, `GET /reports/pnl?month=YYYY-MM`, CRUD `/expenses`, `/payment-methods`.
- Kasir: buka shift `POST /cash-sessions/open`, jual `POST /sales` (wajib header `Idempotency-Key: <uuid>`), tutup shift `POST /cash-sessions/{id}/close` (selisih kas otomatis).
- Refund/retur: `POST /sales/{id}/refund` (sale PAID maupun UNPAID; stok kembali, kas keluar tercatat di `refunds`).
- Auth: login mengembalikan `token` + `refresh_token`; `POST /auth/refresh` untuk JWT baru; `POST /auth/logout` mencabut refresh token.
- Alert: `GET /alerts` (stok < min_stock, batch expired <= 30 hari).
