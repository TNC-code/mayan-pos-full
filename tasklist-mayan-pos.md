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
- MP-6 — selesai (HEAD f1f25d2): `supplier-return` (+item) & `operational-expense` di ORM;
  `createSupplierReturn` idempotent (lock batch `FOR UPDATE`, `qty ≤ qty_damaged`, movement
  OUT RUSAK), `settleSupplierReturn` REFUNDED/WRITTEN_OFF (+ opex `BARANG_RUSAK` ter-link
  dalam 1 tx, `is_test` mewarisi retur), guard 409 `SUPPLIER_RETURN_SETTLED`;
  `expense.service` ORM (opex sistem immutable 405); `report.service` hybrid
  `sequelize.query` (P&L/dashboard/opname/alerts, `refund_distributor`). Smoke 103 PASS,
  P&L dicocokkan manual dengan psql.
- MP-7 — selesai (HEAD 5d7ee85): model `order-book`(+item), service 100% ORM (create dua
  jalur auth, patch/delete item, transisi status, convert yang mengaitkan `sale_id` ke
  penjualan COMPLETED), `internal-catalog.service` hybrid `sequelize.query` (tanpa
  `harga_beli`), seeder user sistem `bot`. Backlog MP-9 (partial unique `sale_id`) ditutup
  di MP-9.2.
- MP-8 — selesai (HEAD 0f49f90): `services/modules.ts` (katalog 7 modul + harga),
  `middleware/account.ts` (`loadAccount` cache per request + `guardAccountStatus` +
  `requireActiveAccount`), `middleware/module.ts` (`requireModule` → 403
  `MODULE_NOT_ACTIVE` + meta upsell, gate status ikut jalan untuk jalur pra-auth bot),
  `/auth/me` additive (`modules`, `account{…,paket_aktif}`, `hosting_mode`), login 403 saat
  SUSPENDED, seeder trial mengisi 7 modul s.d. `trial_ends_at`.
- MP-9 — selesai (fase terakhir; hardening + paritas + retirement raw SQL):
  - **E2E penuh** `scripts/e2e_mayan.ts` (`npm run e2e:mayan`, 302 PASS / 0 FAIL):
    auth (login/401/refresh rotasi/logout/`/auth/me`), master + RBAC, pembelian→batch→picker
    FIFO→edit batch→top-up→sync harga, POS (CASH/transfer/kasbon+DP+pelunasan, replay
    idempotency, `PRICE_BELOW_COST`/`INSUFFICIENT_STOCK` rollback, void, refund parsial RUSAK),
    shift (open/close + selisih kas), opname GOOD/RUSAK + guard, retur → settle
    REFUNDED/WRITTEN_OFF + opex ter-link, laporan OWNER, order book (internal key → edit →
    status → convert → replay), **matriks gating 4 modul + EXPIRED + SUSPENDED** (tulis &
    pulih lewat `psql`), dan **invariant** (ledger 0 mismatch, 0 sale PAID kurang bayar,
    0 order DONE tanpa `sale_id`, 0 movement yatim). Server dinyalakan/matikan skrip sendiri
    di port uji (3999) — atau `BASE_URL` untuk server yang sudah jalan.
  - **Hardening**: migration `202610120001-order-book-sale-unique` (partial unique
    `order_books(sale_id) WHERE sale_id IS NOT NULL` + pelepasan link duplikat warisan,
    index lama `idx_order_books_sale` di-drop) dan guard app-layer di `convertOrderBook`
    (409 `ORDER_ALREADY_DONE`: satu penjualan hanya menutup satu order book);
    `db:check` kini jadi langkah boot (`server.ts`) **dan** memverifikasi kontrak angka
    (`typeof harga_beli === 'number'`) sebagai jaring anti-drift upgrade Sequelize;
    `db-errors.ts` ditambah regex pesan trigger live (`Hanya penjualan COMPLETED …`,
    `Transisi % -> % tidak diizinkan`, `voided_by dan void_reason wajib diisi`) supaya
    transisi status tidak jatuh ke 500.
  - **Retirement raw SQL**: `src/config/db.ts` (pool `pg`), `src/db/migrate.ts`,
    `src/db/seed.ts` dihapus; `withTx`/`withTransaction`, jalur `PoolClient` di `docno.ts`,
    dan `pool` di `app.ts` (health) / `idempotency.service.ts` (purge) / `server.ts` diganti
    Sequelize (`sequelize.query`). Skrip lama ikut pindah lewat helper `scripts/db.ts`.
    Hybrid `sequelize.query` yang terdokumentasi (laporan, daftar stok, agregasi refund,
    katalog internal, baca opname) SENGAJA dipertahankan.
  - **Dokumentasi**: README (perintah db:*, arsitektur Sequelize, gating/trial, e2e),
    `openapi.yaml` additive di `/auth/me` (modules/account/hosting_mode; 48 path tetap).
  - **Data**: 117 sale sisa smoke MP-4..MP-7 + opex uji ditandai `is_test=true` lewat psql
    (kriteria SKU smoke `MP*/SMK6*/UJI*` + 3 produk smoke bersSKU acak); 0 baris di luar
    kriteria. `supplier_returns` & `operational_expenses` sudah `is_test=true` sejak MP-6.
    Deviasi: `stock_opnames` & `order_books` tidak punya kolom `is_test` (di luar kontrak
    openapi), jadi keduanya ditandai lewatawalan `UJI-` pada `note` saja.
  - Verifikasi akhir: `typecheck` 0 error · `build` 0 error · `db:migrate` (2 migration
    applied) · `db:seed` 2× idempotent · `db:check` OK · `e2e:mayan` 302 PASS / 0 FAIL
    (exit 0, dua kali berturut-turut) · `grep config/db.js` nihil.

---

## MP-1 — Fondasi Sequelize + Baseline + Auth + Products (estimasi 4–5 hari)

### MP-1.1 Setup paket & koneksi
- [x] `package.json`: tambah dependency `sequelize@^6.37` + `umzug@^3.8` (driver `pg` sudah ada); hapus script `migrate` & `seed` lama
- [x] Script baru: `db:migrate`, `db:migrate:undo`, `db:migrate:status`, `db:seed`, `db:check` (lihat plan §D7)
- [x] `src/db/sequelize.ts` (baru): instance Sequelize dari `env.db` — host/port/database/user/password, `pool.max = env.db.max`, `dialectOptions.ssl` bila `DB_SSL`, `dialectOptions.statement_timeout = env.db.statementTimeout`, `logging` hanya non-production, `define.underscored = true`
- [x] `src/db/migrator.ts` (baru): runner Umzug + `SequelizeStorage` (tabel `sequelize_meta`), glob `src/migrations/*.ts` (dev/tsx) / `*.js` (prod/dist), perintah `up|down|status`
- [x] `src/db/seeder.ts` (baru): runner Umzug seeders, glob `src/seeders/*.ts`
- [x] Smoke test koneksi: `tsx -e` connect + `SELECT 1` ke `mayan_pos_dev`

### MP-1.2 Baseline migration (final-state, DB fresh)
- [x] `src/migrations/202610110001-baseline-full-schema.ts` (baru) — sumber DDL: `pg_dump --schema-only inventory_db_dev` + cross-check DDL 0001–0011 di `src/db/migrate.ts`; satu `up()` transaksional berisi:
  - [x] 13 tabel inti + FK: `product`, `product_category`, `product_type`, `stock_batches` (FIFO, `markup_type/markup_value/suggested_price` generated), `stock_movements` (kolom `condition`), `sales` (`is_test`, `tax_amount`), `sale_items`, `payments`, `payment_methods`, `customer`, `user_account` (kolom `role` + CHECK OWNER/KASIR), `stock_opnames`, `stock_opname_items` (kolom rusak/cause/snapshot)
  - [x] Tabel turunan: `idempotency_keys`, `operational_expenses` (`is_test`, `source`, `supplier_return_id`), `refunds`, `refund_items`, `cash_sessions`, `refresh_tokens`, `supplier_returns` (`is_test`, `refund_reference_no`) + `supplier_return_items`, `store_profile` (CHECK id=1), `order_books` + `order_book_items`
  - [x] 5 sequence: `sale_no_seq`, `batch_code_seq`, `opname_no_seq`, `supplier_return_no_seq`, `order_no_seq`
  - [x] 11 trigger + function: `trg_sale_item_apply_movement`, `trg_sale_item_validate`, `trg_sale_item_guard`, `trg_sales_void`, `trg_sales_void_apply` (pasif `RETURN NEW`), `trg_sales_no_delete`, `trg_payments_validate`, `trg_payments_sync_status`, `trg_stock_movement_apply` (versi sadar GOOD/RUSAK + `FOR UPDATE`), `trg_stock_movement_immutable`, `trg_batch_update_product_cost` (versi 0011: INSERT OR UPDATE OF harga, guard batch terbaru)
  - [x] Semua index termasuk partial: `uq_product_barcode/uq_product_sku` (WHERE NOT NULL), `idx_supplier_returns_is_test`, `idx_sales_is_test`, dst.
  - [x] Kolom entitlement di `store_profile`: `modules jsonb DEFAULT '{}'`, `trial_ends_at`, `suspended_at`, `account_status varchar(16) DEFAULT 'TRIAL'` + CHECK 4 status
  - [x] `INSERT INTO store_profile (id, name) VALUES (1,'Toko Saya') ON CONFLICT DO NOTHING`
  - [x] `down()`: DROP semua reverse-FK order (untuk reset dev)
- [x] `src/db/check.ts` ditulis ulang di atas `sequelize.query`: verifikasi 24 tabel + 11 trigger + 4 kolom entitlement + `store_profile` id=1 (penerus `verifyBaseline`)

### MP-1.3 Model inti (subset untuk fase ini)
- [x] `src/models/index.ts`: registry `sequelize` tunggal + `associate()` (associations dideklarasikan bertahap per fase)
- [x] `user-account.model.ts` — `user_account` (id, username, password, full_name, phone, is_active, role); instansi method `verifyPassword(plain)` (bcrypt, `env.bcryptRounds`)
- [x] `refresh-token.model.ts` — `refresh_tokens` (token_hash PK, user_id FK CASCADE, expires_at, revoked_at)
- [x] `product.model.ts` — `product` (nama kolom persis termasuk `desctiption` typo schema lama, `attributes jsonb`, `min_stock`, `unit_conversions`); scope default `is_active=true` + scope `withInactive`
- [x] `product-category.model.ts`, `payment-method.model.ts`, `store-profile.model.ts` (typed getter `modules`), `idempotency-key.model.ts`
- [x] Konvensi terdokumentasi di header `src/models/index.ts`: `freezeTableName`, `underscored`, DECIMAL = string, `updatedAt:false` untuk tabel tanpa `updated_at` (plan §D4)

### MP-1.4 Seeders
- [x] `src/seeders/202610110001-users.seeder.ts`: owner (`SEED_OWNER_PASSWORD`, role OWNER) + kasir1 (`SEED_KASIR_PASSWORD`, role KASIR); guard idempotent per username (tidak ada UNIQUE(username) di schema — pola `WHERE NOT EXISTS` seperti `seed.ts` lama); hash bcrypt `env.bcryptRounds`
- [x] `src/seeders/202610110002-payment-methods.seeder.ts`: CASH / BANK_TRANSFER (requires_reference) / QRIS — guard ON CONFLICT (code)
- [x] `src/seeders/202610110003-store-trial.seeder.ts`: set `account_status='TRIAL'`, `trial_ends_at = now() + interval '90 days'` bila masih default (guard: jangan menimpa trial yang sudah jalan)

### MP-1.5 Auth (login/me/refresh/logout) di atas Sequelize
- [x] `src/services/auth.service.ts` ditulis ulang: `login()` (lookup `UserAccount` by lower(username), cek `is_active` dulu → `verifyPassword` → JWT 12h + refresh 7h tersimpan hash di `RefreshToken`), `refresh()` (rotasi: revoke lama + terbit baru, 401 bila expired/revoked), `logout()` (revoke), `me()` (id, username, full_name, role dari kolom DB)
- [x] `src/middleware/auth.ts`: `requireAuth` verifikasi JWT (logic lama dipertahankan) + load user via model; `requireRole` tidak berubah
- [x] Rate limit login/refresh dari `middleware/rate-limit.ts` tetap terpasang di routes (10 & 30 / 15 menit)

### MP-1.6 CRUD products (slice CRUD contoh)
- [x] `src/services/product.service.ts` ditulis ulang: `listProducts` (filter q/barcode/category_id, paging limit/offset, include kategori), `getProduct`, `createProduct`, `updateProduct`, `deleteProduct` = soft (`is_active=false`) + guard sudah terpakai di transaksi
- [x] Controller & zod schemas lama dipertahankan — hanya ganti panggilan pool → model
- [x] Verifikasi RBAC: `POST/PATCH/DELETE /products` KASIR, OWNER → 403 `FORBIDDEN` (matrix `menu-matrix.md` §6)

### MP-1.7 Verifikasi & acceptance MP-1
- [x] `npm run db:migrate` sukses 2× berturut-turut di `mayan_pos_dev`; `\dt` = 24 tabel; query `pg_trigger` = 11 trigger; `store_profile` punya `modules/trial_ends_at/suspended_at/account_status`
- [x] `npm run db:seed` sukses 2× (idempotent); `db:check` OK
- [x] `POST /auth/login` owner → 200 `{token, refresh_token, user{role:OWNER}}`; kasir1 → role KASIR; password salah → 401 `UNAUTHORIZED`; 11× gagal → 429 `TOO_MANY_REQUESTS`
- [x] `GET /auth/me` 200; `POST /auth/refresh` 200 (token lama tak berlaku — revoked); `POST /auth/logout` → refresh berikutnya 401
- [x] `GET /products?q=&limit=` 200 sesuai shape openapi; `POST /products` KASIR 201; OWNER 403; `PATCH` 200; `DELETE` → `is_active=false`, GET list tidak menampilkan
- [x] `npm run typecheck && npm run build` 0 error; Swagger tetap serve `openapi.yaml` tanpa perubahan path

---

## MP-2 — Master Data Lengkap (estimasi 2 hari)

### MP-2.1 Model tambahan
- [x] `product-type.model.ts`, `customer.model.ts`, `store-profile.model.ts` (GET/PATCH payload receipt)
- [x] Associations: Product↔Category↔Type, Customer↔Sales (ringan)

### MP-2.2 Services Sequelize
- [x] `category.service.ts`: list/create/update (`DUPLICATE` 409 pada nama kembar)
- [x] `category.service.ts`: `listProductTypes/createProductType` (lokasi mengikuti controller master — bukan product.service)
- [x] `customer.service.ts`: list (filter q/phone)/get/create/update
- [x] `payment-method.service.ts`: list/get/create/update (`PAYMENT_METHOD_INACTIVE` saat dipakai bayar — uji di MP-4)
- [x] `store.service.ts`: `getStore` (single row id=1) + `updateStore` (KASIR; OWNER 403)

### MP-2.3 Verifikasi & acceptance MP-2
- [x] Semua endpoint master sesuai `openapi.yaml`: `/categories` GET/POST/PATCH, `/product-types` GET/POST, `/customers` GET/POST/PATCH/GET-by-id, `/payment-methods` CRUD, `/store` GET/PATCH
- [x] RBAC per `menu-matrix.md` §6 (mutasi KASIR, GET both, `PATCH /store` OWNER 403)
- [x] `npm run typecheck` bersih; smoke curl per endpoint 200/201/403 sesuai matrix

---

## MP-3 — Barang Masuk & Stok (estimasi 3 hari)

### MP-3.1 Model tambahan
- [x] `stock-batch.model.ts` (unit_cost, markup_*, qty_remaining, qty_damaged, expiry_date, received_at), `stock-movement.model.ts` (immutable — tidak ada method update di service)
- [x] `src/services/docno.ts` dipertahankan: `nextDocNo(seq, prefix)` via `sequelize.query('SELECT nextval(...)', {transaction})`

### MP-3.2 Pembelian
- [x] `purchase.service.ts` ditulis ulang: `createPurchase` — `sequelize.transaction`: insert batch per item (`batch_code = <PREFIX>-YYYYMMDD-NNN`), movement `IN` per batch (trigger `trg_stock_movement_apply` mengisi qty_remaining), markup AMOUNT/PERCENT → `suggested_price` generated
- [x] `updateBatch` (PATCH `/purchases/batches/{id}`): guard batch belum terpakai movement OUT; trigger `trg_batch_update_product_cost` otomatis sync `harga_beli/harga_jual` produk bila batch terbaru
- [x] `listPurchases`, `getBatch`, `listProductBatches` (picker FIFO kasir: hanya `qty_remaining>0`, order `received_at ASC`)

### MP-3.3 Stok & ledger
- [x] `stock.service.ts`: `listStock` (agregat per produk via raw SQL `sequelize.query` — hybrid plan §D4), `getProductStock`, `listMovements` (filter product/date/type/reference), `getDamagedStock` (nama mengikuti kode existing; qty_damaged > 0 per batch)
- [x] Guard app-layer sebelum INSERT movement: stok cukup → `DAMAGED_QTY_INSUFFICIENT`/`INSUFFICIENT_STOCK` 409 (trigger tetap jaring kedua)

### MP-3.4 Verifikasi & acceptance MP-3
- [x] `POST /purchases` 201 → batch + movement IN + `product.harga_beli/harga_jual` terselaraskan (kasus markup AMOUNT: beli 12.500 + 1.000 → jual 13.500, sesuai contoh migration 0010)
- [x] `PATCH /purchases/batches/{id}`: batch terpakai → ditolak; batch terbaru → harga produk ikut; batch lama → harga produk tidak berubah
- [x] `GET /stock`, `/stock/movements`, `/stock/products/{id}`, `/products/{id}/batches`, `/stock/damaged` shape sesuai openapi
- [x] Ledger immutable: coba UPDATE movement via script → error DB (405 `IMMUTABLE_RECORD` mapping)

---

## MP-4 — POS Inti: Sales, Payments, Void, Refund (estimasi 5 hari)

### MP-4.1 Model transaksi
- [x] `sale.model.ts` (sale_no, status COMPLETED/VOIDED/RETURNED, payment_status UNPAID/PARTIAL/PAID, total/tax, void metadata, is_test), `sale-item.model.ts` (qty desimal, unit_price/unit_cost snapshot, subtotal), `payment.model.ts`, `refund.model.ts` + `refund-item.model.ts`
- [x] Associations: Sale→SaleItems→Product→Batches; Sale→Payments→PaymentMethod; Sale→Refunds→RefundItems

### MP-4.2 Idempotency
- [x] `src/services/idempotency.service.ts` ditulis ulang: `runIdempotent(key, fn)` — `findCreateFind` (`INSERT … ON CONFLICT DO NOTHING`) sebagai klaim dalam transaksi; hit terjadi → kembalikan response tersimpan; error handler → simpan response sebelum COMMIT

### MP-4.3 Checkout & pembayaran
- [x] `sale.service.ts` `createSale` sesuai plan §D5: lock batch FIFO `lock: t.LOCK.UPDATE` → validasi stok/harga → `Sale.create` → `SaleItem.bulkCreate` (trigger menulis movement) → `Payment.create` (trigger sync `payment_status`) → kasbon tanpa customer = 400 (`menu-matrix.md` §8) → simpan response idempotency
- [x] `createPayment` (pelunasan/piutang, `PAYMENT_OVER_TOTAL` 422, metode inactive `PAYMENT_METHOD_INACTIVE`)
- [x] `listSales` (filter date/status/payment_status/customer/include_test, paging), `getSale` (header+items+payments), `listPayments`, `saleReceipt` data (store_profile + outlet-ready)

### MP-4.4 Void & refund
- [x] `voidSale`: hanya COMPLETED+UNPAID (trigger `trg_sales_void` menjaga; app-layer melempar `VOID_NOT_ALLOWED` 409 dengan meta jelas), wajib void_reason → `VOID_REASON_REQUIRED` 422; stok balik ditulis service per item + condition (`fn_sales_void_apply` tetap pasif)
- [x] `refundSale` parsial: items[{sale_item_id, qty, condition}] → `refunds` + `refund_items` + movement balik (GOOD→qty_remaining, RUSAK→qty_damaged); guard `REFUND_QTY_EXCEEDED`/`REFUND_AMOUNT_EXCEEDED`/`REFUND_NOT_ALLOWED`; kas keluar tercatat (cash session dipakai MP-5)

### MP-4.5 Verifikasi & acceptance MP-4
- [x] E2E mini POS: beli → jual tunai (PAID) → jual kasbon UNPAID (wajib customer) → pelunasan → void UNPAID (stok balik GOOD) → refund parsial RUSAK (qty_damaged naik, movement RUSAK tercatat)
- [x] Idempotency: `POST /sales` 2× key sama → response identik, hanya 1 sale_no; tanpa key → 400 `IDEMPOTENCY_KEY_REQUIRED`
- [x] Concurrency: 2 kasir jual bersamaan stok terbatas → 1 sukses, 1 `INSUFFICIENT_STOCK` 409 ( jalankan `tsx scripts/concurrency.ts` subset )
- [x] Anti-overpay & harga < beli ditolak (422) baik oleh app-layer maupun trigger
- [x] Semua path sales sesuai openapi; `is_test` flag tersimpan

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
- [x] `supplier-return.model.ts` + `supplier-return-item.model.ts`, `operational-expense.model.ts`

### MP-6.2 Retur distributor
- [x] `supplier-return.service.ts` `createSupplierReturn` (idempotent): guard `qty ≤ qty_damaged` per batch (`FOR UPDATE`), `return_no` via sequence, movement OUT `condition='RUSAK'`
- [x] `settleSupplierReturn` (idempotent): REFUNDED (method aktif, `refunded_amount ≤ total_cost`) / WRITTEN_OFF → auto-insert opex `category='BARANG_RUSAK'`, `source='SUPPLIER_RETURN'`, link `supplier_return_id` dalam transaksi sama; settle ulang → `SUPPLIER_RETURN_SETTLED` 409

### MP-6.3 Opex & laporan
- [x] `expense.service.ts`: list/get/create/update (OWNER-only), filter tanggal/kategori
- [x] `report.service.ts` (raw SQL hybrid): `pnlReport(month)` (pendapatan, HPP, refund, opex, `refund_distributor`, filter is_test), `dashboard` (hari ini, piutang, low stock, expiring, terlaris), `opnameReport(month)` (per cause, per kategori, top 10, tren 6 bulan), `alerts` (min_stock, expiring ≤ 30 hari — semua role)

### MP-6.4 Verifikasi & acceptance MP-6
- [x] Siklus retur: refund RUSAK → retur PENDING → settle REFUNDED → settle ulang 409; retur kedua WRITTEN_OFF → opex muncul ber-link; P&L memuat `refund_distributor`
- [x] `/reports/*` KASIR → 403 `FORBIDDEN`; `/expenses` GET/POST/PATCH OWNER-only (matrix FE-11)
- [x] `mark-test-data` tetap bekerja; laporan default exclude `is_test`, `?include_test=true` mengembalikan

---

## MP-7 — Order Books WA + Katalog Internal (estimasi 2–3 hari)

### MP-7.1 Model & migration
- [x] `order-book.model.ts` + `order-book-item.model.ts` (status PENDING/PROCESSING/DONE/CANCELLED, item unmatched `product_id NULL`, `match_score`)
- [x] Migration `202610120001-bot-user.ts`: akun sistem `bot` (is_active=false, password random 48 char tak tercatat — pola `ensureBotUser` lama)

### MP-7.2 Services & routes
- [x] `order-book.service.ts`: createOrderBook (generate `order_no` ORD-YYYYMMDD-NNN), patch/delete item (guard DONE → `ORDER_ALREADY_DONE` 409; item terakhir → `ORDER_LAST_ITEM` 422), setOrderBookStatus (transisi divalidasi), convertOrderBook → panggil alur `createSale` MP-4 dalam transaksi + link `sale_id`
- [x] `internal-catalog.service.ts`: daftar produk+stok TANPA harga beli, hanya `X-Internal-Key` (`middleware/internal-key.ts` dipertahankan)
- [x] Route ganda auth `POST /order-books` (internal key ATAU kasir) dipertahankan sebelum `r.use(requireAuth)`

### MP-7.3 Verifikasi & acceptance MP-7
- [x] `POST /order-books` dengan `X-Internal-Key` → 201 (created_by=bot); tanpa key → 401 `INTERNAL_KEY_INVALID`
- [x] Alur kasir: match produk (patch item) → PROCESSING → convert → sale COMPLETED + `sale_id` ter-link; order DONE tak bisa diubah
- [x] Path `/order-books*`, `/internal/catalog` sesuai openapi

---

## MP-8 — Gating Subscription per Modul (estimasi 2–3 hari)

### MP-8.1 Error codes & middleware
- [x] `src/utils/errors.ts`: + `MODULE_NOT_ACTIVE` / `TRIAL_EXPIRED` / `AKUN_SUSPENDED` (403) — sesuai stash & plan §D8
- [x] `src/middleware/entitlement.ts` (baru): `resolveEntitlement` (1 query `StoreProfile.findByPk(1)` per request, cache di `res.locals`), `guardAccountStatus` (TRIAL/ACTIVE lolos; EXPIRED → mutasi 403 `TRIAL_EXPIRED` GET tetap jalan; SUSPENDED → semua 403 `AKUN_SUSPENDED`), `requireModule(code)` (403 `MODULE_NOT_ACTIVE` + meta `{module, price_monthly}`)
- [x] `src/services/subscription.service.ts` (baru): helper hitung status efektif (trial aktif → semua modul terbuka; `valid_until` per modul vs hari ini di `BUSINESS_TZ`), katalog modul & harga usulan sebagai konstanta (reports/shift/wa_order/retur/outlet/api/history)

### MP-8.2 Pemetaan gate ke routes (plan §D8)
- [x] Global: `resolveEntitlement` + `guardAccountStatus` setelah `requireAuth`
- [x] `reports` → `/reports/*` (dan siap `/export/*`) · `shift` → `/cash-sessions/open`, `/cash-sessions/{id}/close` + cek login kasir ke-2 · `wa_order` → `/order-books*` + `/internal/catalog` · `retur` → `/supplier-returns*` · `api` → disiapkan (belum ada path) · `history` → clamp `date_from` ≤ 12 bulan di `/sales` & `/reports/*`
- [x] Urutan eksekusi dijaga: trial → modul → role RBAC (dari stash §7)

### MP-8.3 `/auth/me` additive
- [x] Payload `/auth/me` + `modules` (kode → valid_until) + `account {status, trial_ends_at, paket_aktif}` — field lama tidak berubah (kontrak aman untuk FE lama)

### MP-8.4 Verifikasi & acceptance MP-8
- [x] Seeder trial: akun `TRIAL` 90 hari → semua fitur terbuka
- [x] Uji tabel state: set `account_status='EXPIRED'` manual → `POST /products` 403 `TRIAL_EXPIRED`, `GET /products` 200; `SUSPENDED` → login & semua endpoint 403 `AKUN_SUSPENDED`
- [x] Set `modules` tanpa `reports` → `GET /reports/pnl` 403 `MODULE_NOT_ACTIVE` + meta; dengan valid_until lewat → 403 juga
- [x] Clamp history: `date_from` 13 bulan lalu tanpa modul `history` → di-clamp 12 bulan (response tetap 200)
- [x] Semua 403 gate mengikuti format `{error, code, details?}`

---

## MP-9 — Paritas & Hardening (estimasi 3 hari)

### MP-9.1 Uji paritas penuh
- [x] **E2E penuh** `npm run e2e:mayan` (`scripts/e2e_mayan.ts`, tsx, tanpa dependency baru):
      302 PASS / 0 FAIL di `mayan_pos_dev` pada port uji 3999 (server dinyalakan & dimatikan
      skrip sendiri; `BASE_URL` untuk server yang sudah jalan). Cakupan: auth (login/401/
      refresh rotasi/logout/`/auth/me`), master data + RBAC, pembelian → batch → picker FIFO →
      edit batch → top-up → sinkron harga, POS (CASH/transfer/kasbon+DP+pelunasan, replay
      idempotency, `PRICE_BELOW_COST`/`INSUFFICIENT_STOCK` rollback, void, refund parsial
      RUSAK), shift + selisih kas, opname GOOD/RUSAK + guard, retur → settle
      REFUNDED/WRITTEN_OFF + opex ter-link, laporan OWNER, order book (internal key → edit →
      status → convert → replay), matriks gating 4 modul + EXPIRED + SUSPENDED (psql), dan
      invariant pemenixuan (psql). Deviasi: `npm run e2e` (bash lawas `scripts/e2e.sh`) dan
      `scripts/concurrency.ts` TIDAK dijalankan di MP-9 — cakupannya sudah tertutup skrip e2e di atas.
- [x] `npm run mark-test-data` + verifikasi laporan bersih dari data uji — deviasi: penandaan
      dilakukan langsung lewat psql (kriteria SKU smoke `MP*/SMK6*/UJI*` + 3 produk smoke
      bersSKU acak): 117 sale + 3 opex ditandai `is_test=true`, 0 baris di luar kriteria,
      sehingga P&L produksi = 0 transaksi uji.

### MP-9.2 Retirement raw SQL
- [x] Hapus `src/config/db.ts` (pool pg), `src/db/migrate.ts`, `src/db/seed.ts` lama; pastikan tidak ada import tersisa (`grep -r "config/db.js" src/` → nihil, `typecheck` bersih). Sekalian: `withTx`/`withTransaction`, jalur `PoolClient` di `docno.ts`, `pool` di `app.ts` (health), `idempotency.service.ts` (purge), dan `server.ts` diganti Sequelize; skrip lama pindah ke helper `scripts/db.ts`. Hybrid `sequelize.query` yang terdokumentasi tetap.
- [x] `db:check` dijadikan langkah startup (`server.ts` abort bila schema tak lengkap, dengan pesan "jalankan npm run db:migrate") — sudah aktif sejak MP-1; MP-9 menambah verifikasi kontrak angka (`typeof harga_beli === 'number'`).

### MP-9.3 Dokumen & serah terima
- [x] README.md diperbarui: alur Sequelize (`db:migrate`/`db:seed`/`db:check`), go-live checklist tetap, catatan gating & trial
- [x] `openapi.yaml` versi minor additive (schema `/auth/me` modules+account) bila dianggap perlu — path tidak berubah (48 path tetap)
- [x] Rekap paritas: **48/48 path** `openapi.yaml` menyentuh `scripts/e2e_mayan.ts` (dicek dengan mencocokkan path openapi vs path yang dipanggil skrip; nol path terlewat); update Riwayat di dokumen ini

### MP-9.4 Acceptance akhir
- [x] Build + start di mode produksi (`npm run build && npm start`) dengan DB fresh: migrate → seed → login → jual → laporan lulus tanpa error
- [x] `statement_timeout` aktif (query lambat > 15s terbunuh → 503 `DB_UNAVAILABLE`)
- [x] Zero referensi raw-SQL pool tersisa di `src/`
