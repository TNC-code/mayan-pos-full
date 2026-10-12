# POS Inventory API — Deployment & Operasional

Backend POS inventory (API only, tanpa frontend). PostgreSQL 16 remote, Express + TypeScript + **Sequelize ORM**.

## Menjalankan

```bash
npm install
npm run db:migrate        # skema final: 1 baseline + hardening (idempotent, tabel log sequelize_meta)
npm run db:seed           # user owner/kasir1 + payment methods + store_profile trial (idempotent)
npm run db:check          # verifikasi skema: 24 tabel, 11 trigger, 5 sequence, entitlement, parser angka
npm run build && npm start   # atau: npm run dev (tsx watch)
```

- Swagger: `http://localhost:3000/api-docs`
- Health: `http://localhost:3000/health` (juga dipakai boot: `server.ts` menolak start bila skema tak lengkap)

Perintah lain yang sering dipakai:

```bash
npm run db:migrate:status  # migration applied vs pending
npm run db:migrate:undo    # rollback 1 langkah
npm run e2e:mayan          # E2E penuh (lihat di bawah)
npm run mark-test-data     # tandai data uji is_test=true
npm run typecheck          # tsc --noEmit (src + scripts)
npm run build              # tsc -> dist/
```

## Arsitektur data (Sequelize)

Semua akses DB lewat Sequelize; tidak ada `pg.Pool` mentah lagi.

```
.env ──> src/config/env.ts        validasi zod (tidak diubah sejak pool lama)
     └─> src/db/sequelize.ts      instance Sequelize + parser numeric/int8 -> number
          ├─> src/db/migrator.ts  Umzug + SequelizeStorage (tabel sequelize_meta)
          │    └─> src/migrations/*.ts   DDL skema FINAL (tanpa sequelize.sync)
          ├─> src/db/seeder.ts    Umzug seeders idempotent
          ├─> src/db/check.ts     verifikasi skema + kontrak angka (dipakai saat boot)
          ├─> src/models/*.ts     model per tabel + associations (models/index.ts)
          └─> src/services/*.ts   logika bisnis; transaksi lewat withOrmTx (utils/tx.ts)
```

Aturan yang tetap berlaku:

- **Skema hanya lewat migration** — `sequelize.sync()` tidak pernah dipanggil.
- **Aturan stok/harga tetap ditegakkan trigger PostgreSQL** (11 trigger); service hanya
  memberi pesan error yang ramah sebelum DB menolak.
- **Kontrak angka**: uang/qty adalah NUMBER di response (`openapi.yaml`), bukan string.
  Parser `numeric`/`bigint` dipasang di `src/db/sequelize.ts`; `npm run db:check`
  memverifikasi `typeof harga_beli === 'number'` sebagai jaring anti-drift upgrade Sequelize.
- **Hybrid `sequelize.query` masih dipakai** untuk agregasi lintas tabel yang kompleks
  (laporan P&L/dashboard/opname, daftar stok, agregasi refund, katalog internal).
  SQL-nya verbatim dari versi lama dan nilainya selalu di-bind — jangan di-ORM-kan tanpa alasan.

## Uji end-to-end

```bash
npm run e2e:mayan
```

Skrip `scripts/e2e_mayan.ts` (tsx, tanpa dependency baru) menjalankan seluruh alur aplikasi
— auth, master data + RBAC, pembelian/batch/FIFO, POS (tunai, transfer, kasbon + DP + pelunasan,
idempotency, void, refund parsial), shift, opname, retur distributor + opex, laporan OWNER,
order book, **matriks gating subscription**, dan **invariant pemenixuan** — lalu mencetak
ringkasan `PASS x / FAIL y` dan exit code.

- **Server**: secara default skrip menyalakan server sendiri di port uji (`E2E_PORT`, default 3999)
  lalu mematikannya lagi — paling andal karena rate limit login/refresh mulai dari nol.
  Set `BASE_URL=http://localhost:3000/api/v1` untuk menguji server yang sudah jalan
  (hati-hati: rate limit login 10/15 menit bisa ikut terpotong). `E2E_KEEP_SERVER=1` menahan server uji.
- **Matriks gating & invariant** ditulis lewat `psql` ke `store_profile`; state awal dipulihkan
  100% di blok `finally` (TRIAL + 7 modul), termasuk kalau skrip gagal di tengah jalan.
- Data uji berawalan `UJI-` dan ditandai `is_test=true`, jadi tidak masuk P&L produksi.

## Go-live checklist (P0)

1. **Amankan database** (paling penting — DB saat ini terekspos internet):
   - Firewall/Security Group: izinkan port 5432 HANYA dari IP server API.
   - Aktifkan SSL di PostgreSQL (`ssl=on` + sertifikat), lalu set `DB_SSL=true` di `.env`.
   - Ganti password DB default; jangan commit `.env`.
2. **Role** tersimpan di kolom `user_account.role` (baseline MP-1); tambah/kelola user via DB — `.env OWNER_USERNAMES` hanya fallback awal.
3. **Backup harian**:
   ```bash
   ./scripts/backup.sh                       # tes manual
   crontab -e
   30 2 * * * cd /path/to/inventory_quot && ./scripts/backup.sh >> backups/backup.log 2>&1
   ```
4. **Data uji**: `npm run mark-test-data` — menandai transaksi e2e/smoke `is_test=true` agar tidak mencemari laporan (lihat dengan `?include_test=true`).
5. **Process manager**: `pm2 start ecosystem.config.js && pm2 save && pm2 startup`.
6. `NODE_ENV=production`, JWT_SECRET kuat & unik, gunakan reverse proxy HTTPS (nginx/caddy) di depan app.

## Subscription & gating (MP-8)

Sumber kebenaran entitlement = kolom `store_profile` (baris tunggal id=1): `account_status`
(`TRIAL` | `ACTIVE` | `EXPIRED` | `SUSPENDED`), `trial_ends_at`, `suspended_at`, dan `modules`
(jsonb: kode modul → `valid_until`).

- `TRIAL` 90 hari = semua modul aktif (seeder `202610110003-store-trial` mengisinya s.d. `trial_ends_at`).
- `EXPIRED` → read-only: semua GET tetap jalan, mutasi 403 `TRIAL_EXPIRED`.
- `SUSPENDED` → semua endpoint 403 `AKUN_SUSPENDED`, termasuk login dan jalur bot `X-Internal-Key`.
- Modul per-langganan (403 `MODULE_NOT_ACTIVE` + `details.price_monthly` untuk halaman upsell):
  `reports` → `/reports/*` · `shift` → buka/tutup shift · `wa_order` → `/order-books*` + `/internal/catalog`
  · `retur` → `/supplier-returns*`. Paket inti (master, POS, pembelian, stok, opname, shift baca) tidak digate.
- `GET /auth/me` mengirim `modules` (kode → `{valid_until, active}`), `account` (`status`,
  `trial_ends_at`, `trial_days_left`, `paket_aktif`) dan `hosting_mode` — semuanya additive.

## Operasional harian

- Owner: `GET /reports/dashboard`, `GET /reports/pnl?month=YYYY-MM`, CRUD `/expenses` (OWNER penuh).
- Kasir: buka shift `POST /cash-sessions/open`, jual `POST /sales` (wajib header `Idempotency-Key: <uuid>`), tutup shift `POST /cash-sessions/{id}/close` (selisih kas otomatis).
- Refund/retur: `POST /sales/{id}/refund` (sale PAID; GOOD kembali ke stok jual, RUSAK ke karantina), kas keluar tercatat di `refunds`.
- Auth: login mengembalikan `token` + `refresh_token`; `POST /auth/refresh` merotasi refresh token (yang lama langsung mati); `POST /auth/logout` mencabutnya.
- Order WA: `POST /order-books` menerima `X-Internal-Key` (bot) atau JWT kasir; kasir checkout dulu lewat `POST /sales`, lalu `POST /order-books/{id}/convert` mengaitkan `sale_id`-nya (satu penjualan = satu order book).
- Alert: `GET /alerts` (stok < min_stock, batch expired <= 30 hari).