# Tasklist Eksekusi — Plan Rebuild Mayan POS (Sequelize)

> Sumber spec: `plan-mayan-pos.md` · Prinsip: `fase.md`, `menu-matrix.md` §6
> Status: `[ ]` todo · `[~]` berjalan · `[x]` selesai · `[!]` diblokir
> DB target: `mayan_pos_dev` (fresh kosong) · Branch: `mayan_pos`

## Riwayat
- MP-1..MP-4 — selesai (HEAD 6412167).
- MP-5 — selesai (shift kasir & opname di atas Sequelize):
  - Model `cash-session` (timestamptz `opened_at`/`closed_at`, `timestamps:false`),
    `stock-opname` (DATEONLY + `Sequelize.literal('CURRENT_DATE')`), `stock-opname-item`
    (`difference`/`damaged_difference` GENERATED → setter menolak, pola `subtotal`).
  - `cash-session.service` Sequelize penuh: open (guard sesi OPEN ganda → 409
    `CONCURRENT_CONFLICT`), list (`user_id`/`status` + paging), get, close
    (`expected = opening + Σ payment CASH − Σ refund CASH` sejak `opened_at`,
    `difference = closing − expected`; `note` saat close tidak menimpa note open).
  - `opname.service`: tulis 100% model + `withOrmTx` (snapshot sistem per batch
    `FOR UPDATE`, movement ADJUSTMENT GOOD/RUSAK, guard kapasitas batch &
    `DAMAGED_QTY_INSUFFICIENT`, `nextDocNo('opname')`); baca `listOpnames`/`getOpname`
    tetap hybrid `sequelize.query` dengan SQL agregat versi lama (paritas nilai Rp).
  - Smoke: siklus shift (expected 115000 / counted 114000 / selisih −1000), guard
    buka-ganda & tutup-ganda 409, 2 kasir shift bersamaan, opname GOOD/RUSAK/kapasitas/
    dobel/rollback utuh, ledger 62 batch 0 mismatch, RBAC 403/401.

---

## MP-1 — Fondasi Sequelize + Baseline + Auth + Products (estimasi 4–5 hari)

### MP-1.1 Setup paket & koneksi
- [ ] `package.json`: tambah dependency `sequelize@^6.37` + `umzug@^3.8` (driver `pg` sudah ada); hapus script `migrate` & `seed` lama
- [ ] Script baru: `db:migrate`, `db:migrate:undo`, `db:migrate:status`, `db:seed`, `db:check` (lihat plan §D7)
- [ ] `src/db/sequelize.ts` (baru): instance Sequelize dari `env.db` — host/port/database/user/password, `pool.max = env.db.max`, `dialectOptions.ssl` bila `DB_SSL`, `dialectOptions.statement_timeout = env.db.statementTimeout`, `logging` hanya non-production, `define.underscored = true`
- [ ] `src/db/migrator.ts` (baru): runner Umzug + `SequelizeStorage` (tabel `sequelize_meta`), glob `src/migrations/*.ts` (dev/tsx) / `*.js` (prod/dist), perintah `up|down|status`
- [ ] `src/db/seeder.ts` (baru): runner Umzug seeders, glob `src/seeders/*.ts`
- [ ] Smoke test koneksi: `tsx -e` connect + `SELECT 1` ke `mayan_pos_dev`

### MP-1.2 Baseline migration (final-state, DB fresh)
- [ ] `src/migrations/202610110001-baseline-full-schema.ts` (baru) — sumber DDL: `pg_dump --schema-only inventory_db_dev` + cross-check DDL 0001–0011 di `src/db/migrate.ts`; satu `up()` transaksional berisi:
  - [ ] 13 tabel inti + FK: `product`, `product_category`, `product_type`, `stock_batches` (FIFO, `markup_type/markup_value/suggested_price` generated), `stock_movements` (kolom `condition`), `sales` (`is_test`, `tax_amount`), `sale_items`, `payments`, `payment_methods`, `customer`, `user_account` (kolom `role` + CHECK OWNER/KASIR), `stock_opnames`, `stock_opname_items` (kolom rusak/cause/snapshot)
  - [ ] Tabel turunan: `idempotency_keys`, `operational_expenses` (`is_test`, `source`, `supplier_return_id`), `refunds`, `refund_items`, `cash_sessions`, `refresh_tokens`, `supplier_returns` (`is_test`, `refund_reference_no`) + `supplier_return_items`, `store_profile` (CHECK id=1), `order_books` + `order_book_items`
  - [ ] 5 sequence: `sale_no_seq`, `batch_code_seq`, `opname_no_seq`, `supplier_return_no_seq`, `order_no_seq`
  - [ ] 11 trigger + function: `trg_sale_item_apply_movement`, `trg_sale_item_validate`, `trg_sale_item_guard`, `trg_sales_void`, `trg_sales_void_apply` (pasif `RETURN NEW`), `trg_sales_no_delete`, `trg_payments_validate`, `trg_payments_sync_status`, `trg_stock_movement_apply` (versi sadar GOOD/RUSAK + `FOR UPDATE`), `trg_stock_movement_immutable`, `trg_batch_update_product_cost` (versi 0011: INSERT OR UPDATE OF harga, guard batch terbaru)
  - [ ] Semua index termasuk partial: `uq_product_barcode/uq_product_sku` (WHERE NOT NULL), `idx_supplier_returns_is_test`, `idx_sales_is_test`, dst.
  - [ ] Kolom entitlement di `store_profile`: `modules jsonb DEFAULT '{}'`, `trial_ends_at`, `suspended_at`, `account_status varchar(16) DEFAULT 'TRIAL'` + CHECK 4 status
  - [ ] `INSERT INTO store_profile (id, name) VALUES (1,'Toko Saya') ON CONFLICT DO NOTHING`
  - [ ] `down()`: DROP semua reverse-FK order (untuk reset dev)
- [ ] `src/db/check.ts` ditulis ulang di atas `sequelize.query`: verifikasi 24 tabel + 11 trigger + 4 kolom entitlement + `store_profile` id=1 (penerus `verifyBaseline`)

### MP-1.3 Model inti (subset untuk fase ini)
- [ ] `src/models/index.ts`: registry `sequelize` tunggal + `associate()` (associations dideklarasikan bertahap per fase)
- [ ] `user-account.model.ts` — `user_account` (id, username, password, full_name, phone, is_active, role); instansi method `verifyPassword(plain)` (bcrypt, `env.bcryptRounds`)
- [ ] `refresh-token.model.ts` — `refresh_tokens` (token_hash PK, user_id FK CASCADE, expires_at, revoked_at)
- [ ] `product.model.ts` — `product` (nama kolom persis termasuk `desctiption` typo schema lama, `attributes jsonb`, `min_stock`, `unit_conversions`); scope default `is_active=true` + scope `withInactive`
- [ ] `product-category.model.ts`, `payment-method.model.ts`, `store-profile.model.ts` (typed getter `modules`), `idempotency-key.model.ts`
- [ ] Konvensi terdokumentasi di header `src/models/index.ts`: `freezeTableName`, `underscored`, DECIMAL = string, `updatedAt:false` untuk tabel tanpa `updated_at` (plan §D4)

### MP-1.4 Seeders
- [ ] `src/seeders/202610110001-users.seeder.ts`: owner (`SEED_OWNER_PASSWORD`, role OWNER) + kasir1 (`SEED_KASIR_PASSWORD`, role KASIR); guard idempotent per username (tidak ada UNIQUE(username) di schema — pola `WHERE NOT EXISTS` seperti `seed.ts` lama); hash bcrypt `env.bcryptRounds`
- [ ] `src/seeders/202610110002-payment-methods.seeder.ts`: CASH / BANK_TRANSFER (requires_reference) / QRIS — guard ON CONFLICT (code)
- [ ] `src/seeders/202610110003-store-trial.seeder.ts`: set `account_status='TRIAL'`, `trial_ends_at = now() + interval '90 days'` bila masih default (guard: jangan menimpa trial yang sudah jalan)

### MP-1.5 Auth (login/me/refresh/logout) di atas Sequelize
- [ ] `src/services/auth.service.ts` ditulis ulang: `login()` (lookup `UserAccount` by lower(username), cek `is_active` dulu → `verifyPassword` → JWT 12h + refresh 7h tersimpan hash di `RefreshToken`), `refresh()` (rotasi: revoke lama + terbit baru, 401 bila expired/revoked), `logout()` (revoke), `me()` (id, username, full_name, role dari kolom DB)
- [ ] `src/middleware/auth.ts`: `requireAuth` verifikasi JWT (logic lama dipertahankan) + load user via model; `requireRole` tidak berubah
- [ ] Rate limit login/refresh dari `middleware/rate-limit.ts` tetap terpasang di routes (10 & 30 / 15 menit)

### MP-1.6 CRUD products (slice CRUD contoh)
- [ ] `src/services/product.service.ts` ditulis ulang: `listProducts` (filter q/barcode/category_id, paging limit/offset, include kategori), `getProduct`, `createProduct`, `updateProduct`, `deleteProduct` = soft (`is_active=false`) + guard sudah terpakai di transaksi
- [ ] Controller & zod schemas lama dipertahankan — hanya ganti panggilan pool → model
- [ ] Verifikasi RBAC: `POST/PATCH/DELETE /products` KASIR, OWNER → 403 `FORBIDDEN` (matrix `menu-matrix.md` §6)

### MP-1.7 Verifikasi & acceptance MP-1
- [ ] `npm run db:migrate` sukses 2× berturut-turut di `mayan_pos_dev`; `\dt` = 24 tabel; query `pg_trigger` = 11 trigger; `store_profile` punya `modules/trial_ends_at/suspended_at/account_status`
- [ ] `npm run db:seed` sukses 2× (idempotent); `db:check` OK
- [ ] `POST /auth/login` owner → 200 `{token, refresh_token, user{role:OWNER}}`; kasir1 → role KASIR; password salah → 401 `UNAUTHORIZED`; 11× gagal → 429 `TOO_MANY_REQUESTS`
- [ ] `GET /auth/me` 200; `POST /auth/refresh` 200 (token lama tak berlaku — revoked); `POST /auth/logout` → refresh berikutnya 401
- [ ] `GET /products?q=&limit=` 200 sesuai shape openapi; `POST /products` KASIR 201; OWNER 403; `PATCH` 200; `DELETE` → `is_active=false`, GET list tidak menampilkan
- [ ] `npm run typecheck && npm run build` 0 error; Swagger tetap serve `openapi.yaml` tanpa perubahan path

---

## MP-2 — Master Data Lengkap (estimasi 2 hari)

### MP-2.1 Model tambahan
- [ ] `product-type.model.ts`, `customer.model.ts`, `store-profile.model.ts` (GET/PATCH payload receipt)
- [ ] Associations: Product↔Category↔Type, Customer↔Sales (ringan)

### MP-2.2 Services Sequelize
- [ ] `category.service.ts`: list/create/update (`DUPLICATE` 409 pada nama kembar)
- [x] `category.service.ts`: `listProductTypes/createProductType` (lokasi mengikuti controller master — bukan product.service)
- [ ] `customer.service.ts`: list (filter q/phone)/get/create/update
- [ ] `payment-method.service.ts`: list/get/create/update (`PAYMENT_METHOD_INACTIVE` saat dipakai bayar — uji di MP-4)
- [ ] `store.service.ts`: `getStore` (single row id=1) + `updateStore` (KASIR; OWNER 403)

### MP-2.3 Verifikasi & acceptance MP-2
- [ ] Semua endpoint master sesuai `openapi.yaml`: `/categories` GET/POST/PATCH, `/product-types` GET/POST, `/customers` GET/POST/PATCH/GET-by-id, `/payment-methods` CRUD, `/store` GET/PATCH
- [ ] RBAC per `menu-matrix.md` §6 (mutasi KASIR, GET both, `PATCH /store` OWNER 403)
- [ ] `npm run typecheck` bersih; smoke curl per endpoint 200/201/403 sesuai matrix

---

## MP-3 — Barang Masuk & Stok (estimasi 3 hari)

### MP-3.1 Model tambahan
- [ ] `stock-batch.model.ts` (unit_cost, markup_*, qty_remaining, qty_damaged, expiry_date, received_at), `stock-movement.model.ts` (immutable — tidak ada method update di service)
- [ ] `src/services/docno.ts` dipertahankan: `nextDocNo(seq, prefix)` via `sequelize.query('SELECT nextval(...)', {transaction})`

### MP-3.2 Pembelian
- [ ] `purchase.service.ts` ditulis ulang: `createPurchase` — `sequelize.transaction`: insert batch per item (`batch_code = <PREFIX>-YYYYMMDD-NNN`), movement `IN` per batch (trigger `trg_stock_movement_apply` mengisi qty_remaining), markup AMOUNT/PERCENT → `suggested_price` generated
- [ ] `updateBatch` (PATCH `/purchases/batches/{id}`): guard batch belum terpakai movement OUT; trigger `trg_batch_update_product_cost` otomatis sync `harga_beli/harga_jual` produk bila batch terbaru
- [ ] `listPurchases`, `getBatch`, `listProductBatches` (picker FIFO kasir: hanya `qty_remaining>0`, order `received_at ASC`)

### MP-3.3 Stok & ledger
- [x] `stock.service.ts`: `listStock` (agregat per produk via raw SQL `sequelize.query` — hybrid plan §D4), `getProductStock`, `listMovements` (filter product/date/type/reference), `getDamagedStock` (nama mengikuti kode existing; qty_damaged > 0 per batch)
- [ ] Guard app-layer sebelum INSERT movement: stok cukup → `DAMAGED_QTY_INSUFFICIENT`/`INSUFFICIENT_STOCK` 409 (trigger tetap jaring kedua)

### MP-3.4 Verifikasi & acceptance MP-3
- [ ] `POST /purchases` 201 → batch + movement IN + `product.harga_beli/harga_jual` terselaraskan (kasus markup AMOUNT: beli 12.500 + 1.000 → jual 13.500, sesuai contoh migration 0010)
- [ ] `PATCH /purchases/batches/{id}`: batch terpakai → ditolak; batch terbaru → harga produk ikut; batch lama → harga produk tidak berubah
- [ ] `GET /stock`, `/stock/movements`, `/stock/products/{id}`, `/products/{id}/batches`, `/stock/damaged` shape sesuai openapi
- [ ] Ledger immutable: coba UPDATE movement via script → error DB (405 `IMMUTABLE_RECORD` mapping)

---

## MP-4 — POS Inti: Sales, Payments, Void, Refund (estimasi 5 hari)

### MP-4.1 Model transaksi
- [ ] `sale.model.ts` (sale_no, status COMPLETED/VOIDED/RETURNED, payment_status UNPAID/PARTIAL/PAID, total/tax, void metadata, is_test), `sale-item.model.ts` (qty desimal, unit_price/unit_cost snapshot, subtotal), `payment.model.ts`, `refund.model.ts` + `refund-item.model.ts`
- [ ] Associations: Sale→SaleItems→Product→Batches; Sale→Payments→PaymentMethod; Sale→Refunds→RefundItems

### MP-4.2 Idempotency
- [ ] `src/services/idempotency.service.ts` ditulis ulang: `runIdempotent(key, fn)` — `findCreateFind` (`INSERT … ON CONFLICT DO NOTHING`) sebagai klaim dalam transaksi; hit terjadi → kembalikan response tersimpan; error handler → simpan response sebelum COMMIT

### MP-4.3 Checkout & pembayaran
- [ ] `sale.service.ts` `createSale` sesuai plan §D5: lock batch FIFO `lock: t.LOCK.UPDATE` → validasi stok/harga → `Sale.create` → `SaleItem.bulkCreate` (trigger menulis movement) → `Payment.create` (trigger sync `payment_status`) → kasbon tanpa customer = 400 (`menu-matrix.md` §8) → simpan response idempotency
- [ ] `createPayment` (pelunasan/piutang, `PAYMENT_OVER_TOTAL` 422, metode inactive `PAYMENT_METHOD_INACTIVE`)
- [ ] `listSales` (filter date/status/payment_status/customer/include_test, paging), `getSale` (header+items+payments), `listPayments`, `saleReceipt` data (store_profile + outlet-ready)

### MP-4.4 Void & refund
- [ ] `voidSale`: hanya COMPLETED+UNPAID (trigger `trg_sales_void` menjaga; app-layer melempar `VOID_NOT_ALLOWED` 409 dengan meta jelas), wajib void_reason → `VOID_REASON_REQUIRED` 422; stok balik ditulis service per item + condition (`fn_sales_void_apply` tetap pasif)
- [ ] `refundSale` parsial: items[{sale_item_id, qty, condition}] → `refunds` + `refund_items` + movement balik (GOOD→qty_remaining, RUSAK→qty_damaged); guard `REFUND_QTY_EXCEEDED`/`REFUND_AMOUNT_EXCEEDED`/`REFUND_NOT_ALLOWED`; kas keluar tercatat (cash session dipakai MP-5)

### MP-4.5 Verifikasi & acceptance MP-4
- [ ] E2E mini POS: beli → jual tunai (PAID) → jual kasbon UNPAID (wajib customer) → pelunasan → void UNPAID (stok balik GOOD) → refund parsial RUSAK (qty_damaged naik, movement RUSAK tercatat)
- [ ] Idempotency: `POST /sales` 2× key sama → response identik, hanya 1 sale_no; tanpa key → 400 `IDEMPOTENCY_KEY_REQUIRED`
- [ ] Concurrency: 2 kasir jual bersamaan stok terbatas → 1 sukses, 1 `INSUFFICIENT_STOCK` 409 ( jalankan `tsx scripts/concurrency.ts` subset )
- [ ] Anti-overpay & harga < beli ditolak (422) baik oleh app-layer maupun trigger
- [ ] Semua path sales sesuai openapi; `is_test` flag tersimpan

---

## MP-5 — Shift Kasir & Opname (estimasi 3 hari)

### MP-5.1 Model
- [x] `cash-session.model.ts` (OPEN/CLOSED, opening/closing/expected/difference), `stock-opname.model.ts` + `stock-opname-item.model.ts` (physical/system good+damaged, difference generated, cause)

### MP-5.2 Services
- [x] `cash-session.service.ts`: open (guard shift OPEN ganda per user), list/get, close (expected = opening + kas masuk − kas keluar − refund tercatat; `difference` otomatis)
- [x] `opname.service.ts`: createOpname dalam 1 transaksi — snapshot system_qty & system_qty_damaged per batch (`FOR UPDATE`), movement `ADJUSTMENT` GOOD/RUSAK (trigger mengarahkan ke kolom stok yang benar), simpan `cause` + `physical_*`; getOpname (detail + `value_difference` Rp); listOpnames (+total selisih Rp)

### MP-5.3 Verifikasi & acceptance MP-5
- [x] Siklus shift: open → jual tunai → close → difference benar; shift kedua user bersamaan diperbolehkan (user beda), user sama ditolak
- [x] Opname: barang hilang (cause HILANG) → movement ADJUSTMENT minus GOOD; barang rusak fisik → ADJUSTMENT RUSAK → `qty_damaged` naik; nilai rugi Rp terhitung di detail
- [x] Path `/cash-sessions*`, `/opnames*` sesuai openapi; RBAC mutasi KASIR

---

## MP-6 — Retur Distributor, Opex & Laporan OWNER (estimasi 4 hari)

### MP-6.1 Model
- [ ] `supplier-return.model.ts` + `supplier-return-item.model.ts`, `operational-expense.model.ts`

### MP-6.2 Retur distributor
- [ ] `supplier-return.service.ts` `createSupplierReturn` (idempotent): guard `qty ≤ qty_damaged` per batch (`FOR UPDATE`), `return_no` via sequence, movement OUT `condition='RUSAK'`
- [ ] `settleSupplierReturn` (idempotent): REFUNDED (method aktif, `refunded_amount ≤ total_cost`) / WRITTEN_OFF → auto-insert opex `category='BARANG_RUSAK'`, `source='SUPPLIER_RETURN'`, link `supplier_return_id` dalam transaksi sama; settle ulang → `SUPPLIER_RETURN_SETTLED` 409

### MP-6.3 Opex & laporan
- [ ] `expense.service.ts`: list/get/create/update (OWNER-only), filter tanggal/kategori
- [ ] `report.service.ts` (raw SQL hybrid): `pnlReport(month)` (pendapatan, HPP, refund, opex, `refund_distributor`, filter is_test), `dashboard` (hari ini, piutang, low stock, expiring, terlaris), `opnameReport(month)` (per cause, per kategori, top 10, tren 6 bulan), `alerts` (min_stock, expiring ≤ 30 hari — semua role)

### MP-6.4 Verifikasi & acceptance MP-6
- [ ] Siklus retur: refund RUSAK → retur PENDING → settle REFUNDED → settle ulang 409; retur kedua WRITTEN_OFF → opex muncul ber-link; P&L memuat `refund_distributor`
- [ ] `/reports/*` KASIR → 403 `FORBIDDEN`; `/expenses` GET/POST/PATCH OWNER-only (matrix FE-11)
- [ ] `mark-test-data` tetap bekerja; laporan default exclude `is_test`, `?include_test=true` mengembalikan

---

## MP-7 — Order Books WA + Katalog Internal (estimasi 2–3 hari)

### MP-7.1 Model & migration
- [ ] `order-book.model.ts` + `order-book-item.model.ts` (status PENDING/PROCESSING/DONE/CANCELLED, item unmatched `product_id NULL`, `match_score`)
- [ ] Migration `202610120001-bot-user.ts`: akun sistem `bot` (is_active=false, password random 48 char tak tercatat — pola `ensureBotUser` lama)

### MP-7.2 Services & routes
- [ ] `order-book.service.ts`: createOrderBook (generate `order_no` ORD-YYYYMMDD-NNN), patch/delete item (guard DONE → `ORDER_ALREADY_DONE` 409; item terakhir → `ORDER_LAST_ITEM` 422), setOrderBookStatus (transisi divalidasi), convertOrderBook → panggil alur `createSale` MP-4 dalam transaksi + link `sale_id`
- [ ] `internal-catalog.service.ts`: daftar produk+stok TANPA harga beli, hanya `X-Internal-Key` (`middleware/internal-key.ts` dipertahankan)
- [ ] Route ganda auth `POST /order-books` (internal key ATAU kasir) dipertahankan sebelum `r.use(requireAuth)`

### MP-7.3 Verifikasi & acceptance MP-7
- [ ] `POST /order-books` dengan `X-Internal-Key` → 201 (created_by=bot); tanpa key → 401 `INTERNAL_KEY_INVALID`
- [ ] Alur kasir: match produk (patch item) → PROCESSING → convert → sale COMPLETED + `sale_id` ter-link; order DONE tak bisa diubah
- [ ] Path `/order-books*`, `/internal/catalog` sesuai openapi

---

## MP-8 — Gating Subscription per Modul (estimasi 2–3 hari)

### MP-8.1 Error codes & middleware
- [ ] `src/utils/errors.ts`: + `MODULE_NOT_ACTIVE` / `TRIAL_EXPIRED` / `AKUN_SUSPENDED` (403) — sesuai stash & plan §D8
- [ ] `src/middleware/entitlement.ts` (baru): `resolveEntitlement` (1 query `StoreProfile.findByPk(1)` per request, cache di `res.locals`), `guardAccountStatus` (TRIAL/ACTIVE lolos; EXPIRED → mutasi 403 `TRIAL_EXPIRED` GET tetap jalan; SUSPENDED → semua 403 `AKUN_SUSPENDED`), `requireModule(code)` (403 `MODULE_NOT_ACTIVE` + meta `{module, price_monthly}`)
- [ ] `src/services/subscription.service.ts` (baru): helper hitung status efektif (trial aktif → semua modul terbuka; `valid_until` per modul vs hari ini di `BUSINESS_TZ`), katalog modul & harga usulan sebagai konstanta (reports/shift/wa_order/retur/outlet/api/history)

### MP-8.2 Pemetaan gate ke routes (plan §D8)
- [ ] Global: `resolveEntitlement` + `guardAccountStatus` setelah `requireAuth`
- [ ] `reports` → `/reports/*` (dan siap `/export/*`) · `shift` → `/cash-sessions/open`, `/cash-sessions/{id}/close` + cek login kasir ke-2 · `wa_order` → `/order-books*` + `/internal/catalog` · `retur` → `/supplier-returns*` · `api` → disiapkan (belum ada path) · `history` → clamp `date_from` ≤ 12 bulan di `/sales` & `/reports/*`
- [ ] Urutan eksekusi dijaga: trial → modul → role RBAC (dari stash §7)

### MP-8.3 `/auth/me` additive
- [ ] Payload `/auth/me` + `modules` (kode → valid_until) + `account {status, trial_ends_at, paket_aktif}` — field lama tidak berubah (kontrak aman untuk FE lama)

### MP-8.4 Verifikasi & acceptance MP-8
- [ ] Seeder trial: akun `TRIAL` 90 hari → semua fitur terbuka
- [ ] Uji tabel state: set `account_status='EXPIRED'` manual → `POST /products` 403 `TRIAL_EXPIRED`, `GET /products` 200; `SUSPENDED` → login & semua endpoint 403 `AKUN_SUSPENDED`
- [ ] Set `modules` tanpa `reports` → `GET /reports/pnl` 403 `MODULE_NOT_ACTIVE` + meta; dengan valid_until lewat → 403 juga
- [ ] Clamp history: `date_from` 13 bulan lalu tanpa modul `history` → di-clamp 12 bulan (response tetap 200)
- [ ] Semua 403 gate mengikuti format `{error, code, details?}`

---

## MP-9 — Paritas & Hardening (estimasi 3 hari)

### MP-9.1 Uji paritas penuh
- [ ] `npm run e2e` (`scripts/e2e.sh`) hijau penuh di `mayan_pos_dev` — UC A–D + matriks RBAC 88 kasus (port uji terpisah)
- [ ] `tsx scripts/concurrency.ts` 18/18 PASS (2 kasir: oversell, idempotency, sequence docno)
- [ ] `npm run mark-test-data` + verifikasi laporan bersih dari data uji

### MP-9.2 Retirement raw SQL
- [ ] Hapus `src/config/db.ts` (pool pg), `src/db/migrate.ts`, `src/db/seed.ts` lama; pastikan tidak ada import tersisa (`grep -r "config/db.js" src/`)
- [ ] `db:check` dijadikan langkah startup (`server.ts` abort bila schema tak lengkap, dengan pesan "jalankan npm run db:migrate")

### MP-9.3 Dokumen & serah terima
- [ ] README.md diperbarui: alur Sequelize (`db:migrate`/`db:seed`/`db:check`), go-live checklist tetap, catatan gating & trial
- [ ] `openapi.yaml` versi minor additive (schema `/auth/me` modules+account) bila dianggap perlu — path tidak berubah
- [ ] Rekap paritas: daftar 48 path → status tested OK; update Riwayat di dokumen ini

### MP-9.4 Acceptance akhir
- [ ] Build + start di mode produksi (`npm run build && npm start`) dengan DB fresh: migrate → seed → login → jual → laporan lulus tanpa error
- [ ] `statement_timeout` aktif (query lambat > 15s terbunuh → 503 `DB_UNAVAILABLE`)
- [ ] Zero referensi raw-SQL pool tersisa di `src/`
