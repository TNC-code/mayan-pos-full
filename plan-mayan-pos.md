# Plan — Rebuild Backend Mayan POS (Sequelize ORM + PostgreSQL)

> **Status: 📋 PLAN SIAP EKSEKUSI — belum ada kode.** Branch kerja: `mayan_pos`, DB target:
> `mayan_pos_dev` (fresh kosong, 24 tabel target + 11 trigger penjaga).
> Sumber konteks: `src/db/migrate.ts` (0001–0011) · `openapi.yaml` (48 path, base `/api/v1`) ·
> `menu-matrix.md` §5–§6 · `plan-subscription-tiering.md` (model **subscription per modul**) ·
> `plan-saas-platform.md` §4 (DB-per-tenant; console ditunda) · `fase.md` (aturan wajib aplikasi) ·
> WIP gate raw SQL di `git stash` (referensi perilaku, **tidak** dipakai).
> Eksekusi: `tasklist-mayan-pos.md` (checklist per fase MP-1…MP-9).

---

## 1. Ringkasan & Tujuan

Backend POS inventory multi-terminal saat ini = Express + TypeScript + **raw SQL (`pg.Pool`)**.
Rebuild ini **mengganti lapisan akses data menjadi Sequelize ORM** pada DB fresh `mayan_pos_dev`,
dengan tiga prinsip yang tidak bisa ditawar:

1. **Kontrak API tidak berubah** — 48 path `openapi.yaml`, bentuk response, format error
   `{error, code, details?}`, header `Idempotency-Key`, dan RBAC matrix `menu-matrix.md` §6
   dipertahankan persis agar app Flutter (`fe/`) tidak rusak.
2. **Jaminan integritas tidak turun** — 11 trigger penjaga DB (anti-oversell, ledger immutable,
   harga jual ≥ harga beli, sync status bayar, FIFO costing, dst.) **tetap di DB**, bukan dipindah
   ke aplikasi (keputusan D3).
3. **Fitur bisnis baru sejak awal** — subscription per modul (trial 90 hari → Paket INVENTARIS
   Rp49rb + modul à la carte) di-desain masuk ke baseline schema (kolom entitlement di
   `store_profile`), bukan di-retrofit belakangan.

Yang diganti hanyalah **cara bicara ke DB** (raw SQL → Sequelize + migrations); controller,
routes, zod schemas, middleware auth/rate-limit/validate, dan error map dipertahankan.

---

## 2. Konteks Eksisting yang Dipakai

| Aset existing | Peran dalam rebuild |
|---|---|
| `inventory_db_dev` (DB lama, 24 tabel + 11 trigger) | **Sumber kebenaran DDL** — baseline migration direkonstruksi dari `pg_dump --schema-only` DB ini + revisi DDL 0001–0011 yang terdokumentasi di `src/db/migrate.ts` |
| `src/db/migrate.ts` | Dokumentasi evolusi schema (idempotency_keys, opex, hardening, store_profile, retur/opname rusak, order_books, batch markup). Di-rebuild jadi migration Umzug |
| `openapi.yaml` | Kontrak API final; TIDAK diubah path/response-nya |
| `src/controllers/`, `src/routes/index.ts`, `src/controllers/schemas.ts` (zod) | Dipertahankan; hanya service-layer yang ditulis ulang |
| `src/middleware/` (auth, rate-limit, validate, internal-key, error-handler) | Dipertahankan |
| `src/utils/errors.ts` | Dipertahankan persis (peta code → HTTP); +3 kode gate: `MODULE_NOT_ACTIVE`, `TRIAL_EXPIRED`, `AKUN_SUSPENDED` (403, sesuai stash) |
| `src/config/env.ts` | Dipertahankan; `src/db/sequelize.ts` membaca `env.db` yang sama (HOST/PORT/POSTGRES_*/DB_POOL_MAX/DB_SSL/DB_STATEMENT_TIMEOUT_MS) |
| Stash WIP gate (`git stash show -p stash@{0}`) | Referensi perilaku gate & DDL entitlement 0012 — dieksekusi ulang versi Sequelize |
| `scripts/e2e.sh`, `scripts/concurrency.ts` | Dipakai ulang sebagai uji paritas MP-9 |

**DB target**: `mayan_pos_dev` @ 139.190.100.175:5432 (terverifikasi kosong: `\dt` → "Did not
find any relations"). DB lama **tidak disentuh**; migrasi data produksi = keputusan terpisah
setelah paritas fitur tercapai (MP-9).

---

## 3. Keputusan Teknis

### D1 — Versi & struktur Sequelize

| Hal | Keputusan |
|---|---|
| Paket | `sequelize@^6.37` (stable GA; v7 masih beta — **tidak** dipakai di sistem uang), driver `pg` yang sudah ada |
| Ekstensi TS | **Tanpa `sequelize-typescript`** — pakai `Model.init(attrs, opts)` + interface atribut (tanpa decorator; tidak menyentuh `tsconfig`, kompatibel `tsx` & `tsc`) |
| Migrations | **Umzug `^3.8` + SequelizeStorage** (tabel log `sequelize_meta`) — bukan sequelize-cli (struktur config-nya sendiri bentrok dengan `src/config/env.ts`) |
| `sync()` | **DILARANG** — schema hanya boleh berubah lewat migration (`npm run db:migrate`) |
| Folder | `src/db/sequelize.ts` (koneksi) · `src/db/migrator.ts` (runner Umzug) · `src/db/seeder.ts` (runner seed Umzug) · `src/models/*.model.ts` + `src/models/index.ts` (registry + associations) · `src/migrations/*.ts` · `src/seeders/*.ts` |
| Pool | `max = env.db.max`, `ssl = env.db.ssl`, `dialectOptions.statement_timeout = env.db.statementTimeout` (15s default — perilaku sama dengan pool lama) |
| `pg.Pool` lama | Diretirement di akhir (MP-9): `src/config/db.ts` dihapus setelah semua service pindah; selama transisi boleh hidup untuk service yang belum migrasi |

### D2 — Migrations (Umzug), bukan sync()

- Setiap perubahan schema = file `src/migrations/<timestamp>-<nama>.ts` dengan `up()`/`down()`,
  **isi SQL mentah** via `queryInterface.sequelize.query()` untuk hal yang tidak bisa
  diekspresikan query interface (trigger, generated column, partial index, sequence).
- **Baseline** = 1 migration final-state (24 tabel + 5 sequence + 11 trigger + index + constraint
  + kolom entitlement) — DB fresh, tidak perlu arkeologi 0001–0011; log evolusi tetap terbaca
  dari `src/db/migrate.ts` lama. Sumber DDL: `pg_dump --schema-only inventory_db_dev`,
  direview manual terhadap DDL 0001–0011 sebelum di-commit.
- Idempotency: Umzug menandai migration yang sudah jalan di `sequelize_meta`; `down()` wajib ada
  untuk baseline (DROP … IF EXISTS, urutan reverse-FK) walau di dev jarang dipakai.

### D3 — Nasib 11 trigger DB: **DIPERTAHANKAN DI DB** (bukan pindah ke aplikasi)

**Rekomendasi tegas: semua 11 trigger dibuat ulang di `mayan_pos_dev` lewat baseline migration.**
Alasan:

1. **Last line of defense untuk uang & stok.** Trigger (`trg_sale_item_validate`,
   `trg_stock_movement_apply`, `trg_stock_movement_immutable`, `trg_payments_validate`,
   `trg_payments_sync_status`, `trg_sales_no_delete`, `trg_sales_void`, `trg_sale_item_guard`,
   `trg_sale_item_apply_movement`, `trg_batch_update_product_cost`, `trg_sales_void_apply`)
   berlaku **terhadap penulis mana pun** — app, script uji, perbaikan manual via psql. Layer
   aplikasi bisa di-bypass; trigger tidak.
2. **Concurrency 2 kasir.** `fn_stock_movement_apply` sudah melakukan `SELECT … FOR UPDATE` pada
   baris batch sebelum update `qty_remaining`/`qty_damaged` — serialisasi anti-oversell terjadi
   **di dalam transaksi DB**. Memindahkannya ke hooks Sequelize tetap butuh row lock yang sama
   (`lock: t.LOCK.UPDATE`), jadi tidak ada keuntungan, tapi hilang jaring pengaman.
3. **Tanpa round-trip ekstra.** Trigger berjalan in-line dalam transaksi yang sama; validasi di
   app layer + trigger DB = dua lapis tanpa menambah latensi berarti. `statement_timeout` (15s)
   tetap mengikat trigger karena satu koneksi/transaksi.
4. **Uji paritas.** `scripts/concurrency.ts` (18/18 PASS di backend lama) justru menguji perilaku
   DB-level ini; mempertahankan trigger membuat uji paritas MP-9 apple-to-apple.

Pembagian kerja yang dipertahankan dari backend lama (jangan dibalik):
- `fn_sales_void_apply` **sengaja pasif** (`RETURN NEW`) — pengembalian stok saat void/retur
  ditulis **satu penulis di service layer** per item + condition (GOOD/RUSAK), supaya tidak
  terhitung dua kali (keputusan migration 0005 §8).
- `fn_batch_update_product_cost` tetap trigger (sync harga produk dari batch TERBARU, guard edit
  batch lama — migration 0011); Sequelize tidak menulis `harga_beli/harga_jual` produk saat input
  pembelian, hanya membaca.
- **Lapisan aplikasi menambah** validasi ramah yang melempar `ApiError` ber-code **sebelum** SQL
  jalan (stok cukup, harga ≥ beli, payment ≤ total), lalu memetakan pesan exception trigger yang
  lolos ke code yang sama — pola yang sudah ada di `src/utils/errors.ts` ("error DB mengikuti
  pesan trigger"). Jadi error ke FE identik walau sumber tolakannya beda lapis.

### D4 — Konvensi model Sequelize

| Konvensi | Keputusan |
|---|---|
| Nama tabel | **Eksplisit** per model: `tableName: 'product'`, `freezeTableName: true` (schema memakai singular campur plural: `product`, `sale_items`, `stock_opnames`) — tidak mengandalkan pluralize Sequelize |
| Nama kolom | `underscored: true`; nama field TS = snake_case sama dengan kolom (mis. `harga_beli`) supaya mapping response FE tidak perlu transformer |
| Timestamps | Per model sesuai schema: umumnya `createdAt: 'created_at'`, `updatedAt: 'updated_at'`; `stock_movements` & `idempotency_keys` hanya `created_at` (`updatedAt: false`) |
| Numerik uang/qty | `DataTypes.DECIMAL(14,2)/(14,3)` → **dikembalikan sebagai number** — parser per-koneksi di-override via `afterConnect` (`src/db/sequelize.ts`) supaya paritas dengan backend lama (`pg` `setTypeParser`→number) dan kontrak openapi (`type: number`) tidak bergeser. Dilarang memakai `FLOAT/REAL` untuk uang |
| PK `bigint` (`sales`, `stock_batches`, dst.) | `DataTypes.BIGINT` (string dari driver, sama seperti sekarang); FK `integer` (`product`, `user_account`) pakai `INTEGER` — ikuti schema persis |
| Soft delete | `paranoid: false`; produk nonaktif = kolom `is_active=false` (sama dengan `DELETE /products/{id}` lama) |
| Associations | Dideklarasikan terpusat di `src/models/index.ts` (fungsi `associate`) dengan `foreignKey` eksplisit; `Sale.hasMany(SaleItem)`, `SaleItem.belongsTo(Product)`, dst. |
| Scopes | Default scope list = urutan + filter baku tiap endpoint list (mis. sales: `ORDER BY sale_date DESC`, exclude `is_test` kecuali `include_test=true`) |
| Akses raw SQL | Tetap diizinkan **hybrid**: query agregat laporan kompleks (P&L, dashboard, ledger, opname report) memakai `sequelize.query(sql, { transaction })` — ORM untuk DML/transaksi, SQL untuk laporan. Alasan: report SQL lama sudah teruji dan optimasi (partial index `idx_supplier_returns_is_test` dsb.) tidak mau ditulis ulang jadi builder ORM |

### D5 — Desain transaksi (checkout & semua mutasi multi-tabel)

Pola tunggal: **`sequelize.transaction(async (t) => { … })`** dengan `transaction: t` di SEMUA
query di dalamnya (default isolation `READ COMMITTED` — sama dengan PostgreSQL lama; kebenaran
datang dari row lock, bukan isolation level naik).

Checkout `POST /sales` (paritas dengan `sale.service.ts` lama):

1. **Klaim idempotency** — `idempotency_keys` PK `key` + `INSERT … ON CONFLICT DO NOTHING`
   (`findCreateFind`); jika sudah ada → kembalikan `response` tersimpan (409-kode tidak terjadi).
2. `BEGIN`.
3. **FIFO + lock**: ambil batch tersedia `WHERE product_id=? AND qty_remaining>0
   ORDER BY received_at ASC … FOR UPDATE` (`lock: t.LOCK.UPDATE`) — kunci baris dulu, baru hitung
   alokasi; menutup race antar 2 kasir sebelum trigger bekerja.
4. Validasi app-layer (stok cukup → `INSUFFICIENT_STOCK` 409; harga jual ≥ `harga_beli` batch →
   `PRICE_BELOW_COST` 422; kasbon tanpa customer → 400, aturan `menu-matrix.md` §8).
5. `Sale.create` → `SaleItem.bulkCreate` (trigger `trg_sale_item_*` memvalidasi & menulis
   `stock_movements` otomatis) → hitung `total_amount`/`tax_amount` → `Payment.create` bila ada
   (trigger `trg_payments_validate/sync_status` menjaga ≤ total & `payment_status`).
6. Simpan response ke `idempotency_keys.response` dalam transaksi yang sama → `COMMIT`.
7. Catch: mapping `SequelizeUniqueConstraintError` → `DUPLICATE` 409; pesan exception trigger →
   code sesuai tabel di `src/utils/errors.ts`.

Pola sama untuk: `POST /purchases` (batch + movement IN), `POST /sales/{id}/refund` (refund +
refund_items + movement balik berlabel condition), `POST /opnames` (movement ADJUSTMENT),
`POST /supplier-returns` + `/settle` (movement OUT RUSAK + opex write-off otomatis),
`POST /order-books/{id}/convert` (delegasi ke alur checkout), `cash-sessions`.

### D6 — Keamanan & perilaku yang wajib dipertahankan (tidak didesain ulang)

| Perilaku | Sumber | Status |
|---|---|---|
| bcrypt hash (`BCRYPT_ROUNDS=10`) | `src/config/env.ts` | Dipertahankan |
| JWT 12h + refresh token 7h di tabel `refresh_tokens` (hash, revoke saat logout) | `src/services/auth.service.ts` | Ditulis ulang di atas model `RefreshToken`, perilaku sama |
| Rate limit login 10 req/15m, refresh 30/15m → 429 `TOO_MANY_REQUESTS` | `src/middleware/rate-limit.ts` | Dipertahankan apa adanya |
| `Idempotency-Key` wajib di `POST /sales`, `/payments`, `/refund`, `/supplier-returns`, `/settle` | `requireIdempotencyKey` | Dipertahankan |
| Validasi input zod | `src/controllers/schemas.ts` + `middleware/validate.ts` | Dipertahankan (tetap zod, bukan validator Sequelize) |
| Error map code → HTTP | `src/utils/errors.ts` | **Persis sama**; hanya +3 kode gate 403 (D8) |
| Penomoran dokumen dari SEQUENCE DB (`sale_no_seq`, dst. via `docno.ts`) | `src/services/docno.ts` | Dipertahankan (sequence sudah dibuat baseline) |
| Penandaan data uji `is_test` + `mark-test-data` | `scripts/mark-test-data.ts` | Dipertahankan |
| Akun sistem `bot` (is_active=false, random password tak tercatat) | migration lama | Dibuat ulang sebagai migration MP-7 |

### D7 — Skrip npm (menggantikan `migrate`/`seed` raw SQL)

```jsonc
"db:migrate":        "tsx src/db/migrator.ts up",       // jalankan migration pending (idempotent)
"db:migrate:undo":   "tsx src/db/migrator.ts down",     // rollback 1 langkah
"db:migrate:status": "tsx src/db/migrator.ts status",   // daftar applied/pending
"db:seed":           "tsx src/db/seeder.ts",            // seeders idempotent (up all, guard di dalam)
"db:check":          "tsx src/db/check.ts"              // verifikasi 24 tabel + 11 trigger + entitlement (penerus verifyBaseline)
```

- `migrate` & `seed` lama dihapus dari `package.json` pada MP-1 (mencegah dua jalur schema).
- Migration/seed dijalankan dengan kredensial `.env` yang sama; aman diulang; `db:migrate` di
  deploy pipeline = langkah wajib sebelum `npm start` (pola README lama).
- Prod: `dist/` — migrator memilih glob `*.js` vs `*.ts` dari ekstensi `__filename` (tsx dev,
  node prod).

### D8 — Gating subscription per modul (Sequelize-aware)

Entitlement disimpan **di tenant DB** (kolom `store_profile`, satu baris id=1) — sesuai
`plan-subscription-tiering.md` (revisi per-modul) & DDL 0012 di stash; console/platform datang
belakangan (`plan-saas-platform.md` ditunda) dan nanti hanya **menulis** kolom ini.

Kolom (masuk baseline migration, karena DB fresh):

```sql
ALTER TABLE public.store_profile
  ADD COLUMN modules        jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- {"reports":{"valid_until":"2026-12-05"}, ...}
  ADD COLUMN trial_ends_at  timestamptz,                               -- sisa trial 90 hari
  ADD COLUMN suspended_at   timestamptz,
  ADD COLUMN account_status varchar(16) NOT NULL DEFAULT 'TRIAL';      -- TRIAL|ACTIVE|EXPIRED|SUSPENDED
```

Middleware (dua lapis, urutan **trial → modul → role RBAC**):

1. `resolveEntitlement` — pasang setelah `requireAuth`: `StoreProfile.findByPk(1)` **1 query per
   request**, hasil di-cache di `res.locals.entitlement` untuk pemakaian middleware berikutnya di
   request yang sama (tanpa cache lintas-request; PK lookup murah dan selalu segar).
2. `guardAccountStatus` global — `TRIAL`/`ACTIVE` lolos; `EXPIRED` → semua POST/PATCH/DELETE
   403 `TRIAL_EXPIRED` (GET tetap jalan, read-only grace); `SUSPENDED` → semua endpoint 403
   `AKUN_SUSPENDED` (termasuk blok login).
3. `requireModule(code)` per route — baca `modules[code].valid_until < today` → 403
   `MODULE_NOT_ACTIVE` + meta `{module, price_monthly}` untuk halaman upsell FE.
   Pemetaan endpoint → modul (sama dengan stash): `reports`→`/reports/*`+`/export/*` ·
   `shift`→`/cash-sessions/open|close` + login kasir ke-2 · `wa_order`→`/order-books*`+
   `/internal/catalog` · `retur`→`/supplier-returns*` · `api`→(disiapkan, belum ada) ·
   `history`→clamp `date_from` pada `/sales` & `/reports/*` (≤12 bulan).
4. `/auth/me` **ditambah** field additive (backward-compatible): `modules`, `account:
   {status, trial_ends_at, paket_aktif}` — path & field lama tidak berubah.

Tiga error code baru di `src/utils/errors.ts` (sudah diverifikasi dari stash):
`MODULE_NOT_ACTIVE: 403`, `TRIAL_EXPIRED: 403`, `AKUN_SUSPENDED: 403`.

### D9 — Yang TIDAK diubah

- **Kontrak path API**: 48 path `openapi.yaml` base `/api/v1`, bentuk request/response, status
  code, header `Idempotency-Key`/`X-Internal-Key` — field tambahan hanya additive (`/auth/me`).
- **RBAC matrix** `menu-matrix.md` §6: KASIR = semua mutasi; OWNER = semua GET + `/expenses`
  dan `/reports/*` OWNER-only (amandemen FE-11) — tabel `user_account.role` tetap.
- **Format error**: `{error, code, details?}` via `middleware/error-handler.ts`.
- **openapi.yaml** tidak diubah versi/path (penambahan schema opsional di akhir, additive).
- Flutter `fe/` tidak disentuh sama sekali.

---

## 4. Arsitektur Folder (target akhir)

```
src/
├── db/
│   ├── sequelize.ts        # instance Sequelize dari env.db (pool, ssl, statement_timeout)
│   ├── migrator.ts         # runner Umzug (up/down/status) — pengganti db/migrate.ts
│   ├── seeder.ts           # runner Umzug seeders — pengganti db/seed.ts
│   └── check.ts            # verifyBaseline versi Sequelize (24 tabel + 11 trigger + entitlement)
├── models/
│   ├── index.ts            # registry Sequelize + associations + ekspor model
│   ├── user-account.model.ts      ├── refresh-token.model.ts
│   ├── product.model.ts           ├── product-category.model.ts
│   ├── product-type.model.ts      ├── customer.model.ts
│   ├── payment-method.model.ts    ├── stock-batch.model.ts
│   ├── stock-movement.model.ts    ├── sale.model.ts
│   ├── sale-item.model.ts         ├── payment.model.ts
│   ├── refund.model.ts            ├── refund-item.model.ts
│   ├── cash-session.model.ts      ├── stock-opname.model.ts
│   ├── stock-opname-item.model.ts ├── operational-expense.model.ts
│   ├── supplier-return.model.ts   ├── supplier-return-item.model.ts
│   ├── store-profile.model.ts     ├── order-book.model.ts
│   ├── order-book-item.model.ts   └── idempotency-key.model.ts
├── migrations/             # Umzug, SQL mentah dalam TS (baseline + fitur)
├── seeders/                # users, payment-methods, store trial, kategori contoh
├── config/                 # env.ts (tetap); db.ts (pool pg) RETIRED di MP-9
├── controllers/  services/  middleware/  routes/  utils/   # struktur lama dipertahankan
└── server.ts / app.ts      # tetap
```

Urutan middleware request (tidak berubah + entitlement):

```
rateLimit → validate(zod) → requireAuth → resolveEntitlement → guardAccountStatus
          → requireModule(<kode>) → requireRole → controller → service (Sequelize) → DB
```

---

## 5. Fase Kerja (vertical slice, estimasi ±29 hari)

Setiap fase = slice vertikal yang berakhir **endpoint hidup + teruji**, bukan lapisan mengganggur.
Acceptance criteria terukur ada di `tasklist-mayan-pos.md` per fase.

| Fase | Isi | Estimasi |
|---|---|---|
| **MP-1 Fondasi** | Setup Sequelize + `db/sequelize.ts` + runner Umzug; baseline migration final-state (24 tabel + 11 trigger + entitlement); model inti (user, refresh-token, product, product-category, payment-method, store-profile, idempotency-key); seeders owner/kasir1 + payment methods + trial store; auth login/me/refresh/logout; CRUD products; skrip npm `db:*`; hapus `migrate`/`seed` lama | 4–5 hari |
| **MP-2 Master data** | Categories, product-types, customers, payment-methods CRUD, store GET/PATCH — semua route lama hidup dengan service Sequelize | 2 hari |
| **MP-3 Barang masuk & stok** | `POST /purchases` (batch + movement IN + markup), `PATCH/GET /purchases/batches/{id}`, `/stock*`, `/products/{id}/batches`, `/stock/damaged`; pola transaksi + `docno` | 3 hari |
| **MP-4 POS inti** | `POST /sales` idempotent (FIFO lock → sale_items → payments), `GET /sales*`, `POST /sales/{id}/payments`, void, refund parsial (GOOD/RUSAK), receipt data; idempotency service Sequelize | 5 hari |
| **MP-5 Shift & opname** | cash-sessions open/list/close (selisih kas), opnames create/detail/list (GOOD/RUSAK + cause + snapshot) | 3 hari |
| **MP-6 Retur + opex + laporan** | supplier-returns + settle (opex write-off otomatis), expenses CRUD, `/reports/pnl|dashboard|opname`, `/alerts` | 4 hari |
| **MP-7 Order books WA** | order_books(+items), jalur `X-Internal-Key` + `requireInternalKeyOrKasir`, `/internal/catalog`, akun bot, convert → checkout | 2–3 hari |
| **MP-8 Gating subscription** | `resolveEntitlement` + `guardAccountStatus` + `requireModule` di semua route group; `/auth/me` + modules; clamp history; seeder trial 90 hari diset aktif | 2–3 hari |
| **MP-9 Paritas & hardening** | e2e penuh `scripts/e2e.sh`, concurrency 2 kasir, matriks RBAC 88 kasus, `db:check` CI-ish, retirement `src/config/db.ts` + `db/migrate.ts` lama, update README | 3 hari |

Prinsip urutan: MP-1 fondasi → MP-2/MP-3 master+stok (prasyarat POS) → MP-4 inti uang →
MP-5/MP-6 operasional & laporan → MP-7 jalur bot → MP-8 gating (di atas semua fitur yang sudah
hidup) → MP-9 paritas. Gating sengaja di akhir supaya tiap fase bisa diuji tanpa terkunci, dan
setelah MP-8 seluruh perilaku 403 diuji sekali jalan.

---

## 6. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| `DECIMAL`/`BIGINT` dari Sequelize bentuk string vs number → response FE bergeser | Parser per-koneksi di-override (`afterConnect`) agar selalu number, paritas dengan backend lama; **tambah assertion smoke test** (`typeof harga_beli === 'number'`) supaya upgrade Sequelize yang mengubah perilaku parser langsung ketahuan; larangan `typeCast` ad-hoc |
| Interaksi `bulkCreate` dengan trigger AFTER ROW | Trigger berjalan normal di INSERT mana pun; diuji di MP-4 dengan kasus 2 kasir concurrent (`scripts/concurrency.ts`) |
| Baseline migration beda tipis dengan DB lama | DDL direkonstruksi dari `pg_dump --schema-only inventory_db_dev` + cross-check DDL 0001–0011; `db:check` memverifikasi 24 tabel + 11 trigger sebelum app start |
| Race idempotency antar 2 POS | Klaim `INSERT … ON CONFLICT DO NOTHING` pada PK `idempotency_keys.key` dalam transaksi; response disimpan sebelum COMMIT |
| Gating memblokir pengujian fase awal | Gate dipasang MP-8 (terakhir sebelum hardening); seed dev selalu `TRIAL` 90 hari sehingga gate terbuka |
| Sequelize v6 vs Node ≥ 26 | Sequelize murni JS (tanpa native binding) — aman; diuji sejak MP-1 via login |
| Penomoran dokumen bentrok saat backfill data lama | `setval` penyesuai sequence dimigrasikan ke `db:check`/script import (hanya relevan saat data lama diimport — di luar scope MP-1…MP-9) |

---

## 7. Referensi

- `src/db/migrate.ts` — evolusi schema lama (sumber DDL baseline rebuild)
- `openapi.yaml` — kontrak API 48 path (tidak diubah)
- `menu-matrix.md` — RBAC + peta menu → endpoint
- `plan-subscription-tiering.md` — model entitlement per modul (spec gating D8)
- `plan-saas-platform.md` — arah multi-tenant (di luar scope rebuild ini)
- `fase.md` — aturan wajib aplikasi (idempotency, sequence, error map)
- `git stash` (`WIP ST-1/ST-2`) — referensi gate raw SQL + DDL entitlement 0012
- `tasklist-mayan-pos.md` — checklist eksekusi fase MP-1…MP-9
