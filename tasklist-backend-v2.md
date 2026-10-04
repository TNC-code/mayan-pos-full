# Tasklist Eksekusi — Plan Backend v2

> Sumber spec: `plan-backend-v2-refund-rusak-opname-rbac.md` · Prinsip: `fase.md`
> Status: `[ ]` todo · `[~]` berjalan · `[x]` selesai · `[!]]` diblokir

## Riwayat
- [x] **T1** Migration 0005 + revisi trigger — selesai (migrate 4× idempotent, data lama utuh)
- [x] **T2** Refund parsial + void berlabel — selesai (e2e 119 PASS, UC 52/52, HTTP 32/32)
- [x] **T3** Retur distributor + write-off opex — selesai (UC 142/142, HTTP 130/130, e2e 119 PASS)
- [x] **T4** Opname detail + laporan analisa — selesai (UC 163/163, HTTP 130/130, e2e 119 PASS, concurrency 18/18)
- [x] **T5** RBAC matrix penuh (OWNER read-only) — selesai (matriks 88 PASS/0 FAIL)
- [x] **T6** P&L `refund_distributor` + flag `is_test` opex — selesai (DDL7 idempotent 2×, 6+3 opex uji ditandai)
- [x] **T7** OpenAPI + `fase.md` + `test_usecase.md` — selesai (36 → 41 path, 58 operation, 0 broken $ref)
- [x] **T8** E2E permanen UC A–D + matriks RBAC — selesai (e2e 245 PASS / 0 FAIL, concurrency 18/18)
- [x] **T9** `supplier_returns.is_test` + filter P&L — selesai (DDL8 idempotent 2×, 27 retur uji ditandai, `refund_distributor` produksi 140.000 → 0)
- [x] **T9** OpenAPI tanpa restart (cache mtime) — selesai (uji `info.title` live tanpa restart + fallback spec invalid)

---

## T3 — Retur Distributor + Write-off Opex

### T3.1 Service `supplier-return.service.ts` (baru)
- [x] `createSupplierReturn(input, userId, idempotencyKey)` via `runIdempotent`:
  - [x] Validasi per item: batch ada, `qty > 0`, `qty ≤ qty_damaged` batch tsb dengan `SELECT ... FOR UPDATE`
  - [x] `return_no` = `RTR-YYYYMMDD-NNN` via `supplier_return_no_seq` (pola `docno.ts`)
  - [x] Insert `supplier_returns` (status `PENDING`, `total_cost` = Σ qty×unit_cost) + `supplier_return_items`
  - [x] Insert `stock_movements OUT` per item: `reference_type='SUPPLIER_RETURN'`, `reference_id=return_id`, `condition='RUSAK'`, `batch_id`, `unit_cost`, note jelas
  - [x] Semua dalam 1 transaksi DB (atomic)

### T3.2 Settle
- [x] `settleSupplierReturn(id, input, userId, idempotencyKey)`:
  - [x] Guard: status harus `PENDING`, selain itu → `SUPPLIER_RETURN_SETTLED` (409)
  - [x] `result='REFUNDED'`: isi `refunded_amount`, `refunded_method_id` (validasi metode aktif), `refunded_at`, `settled_by`, status → `REFUNDED`
  - [x] `result='WRITTEN_OFF'`: status → `WRITTEN_OFF` + **auto-insert `operational_expenses`** dalam transaksi yang sama: `category='BARANG_RUSAK'`, `source='SUPPLIER_RETURN'`, `supplier_return_id`, `amount=total_cost`, `description` memuat `return_no`
  - [x] `refunded_amount ≤ total_cost` (tolak lebih)

### T3.3 Getter
- [x] `listSupplierReturns({status?, date_from?, date_to?, limit, offset})`
- [x] `getSupplierReturn(id)` — header + items + opex hasil write-off (jika ada)
- [x] `getDamagedStock()` di `stock.service.ts` — per batch: `qty_damaged > 0`, join produk, siap diretur

### T3.4 Controller + Routes + Schema
- [x] `supplier-return.controller.ts` (baru)
- [x] Routes (di `routes/index.ts`):
  - [x] `GET  /stock/damaged` (auth semua role)
  - [x] `POST /supplier-returns` — `requireRole('KASIR')` + `requireIdempotencyKey`
  - [x] `GET  /supplier-returns` · `GET /supplier-returns/{id}` (auth semua role)
  - [x] `POST /supplier-returns/:id/settle` — `requireRole('KASIR')` + `requireIdempotencyKey`
- [x] Zod schemas: create (supplier_name, items[{batch_id, qty, unit_cost?}]), settle (discriminated union REFUNDED/WRITTEN_OFF)
- [x] Error map: `SUPPLIER_RETURN_SETTLED` (409), `DAMAGED_QTY_INSUFFICIENT` (409, sudah ada dari T2)

### T3.5 Verifikasi T3
- [x] `npm run typecheck` + `npm run build` bersih
- [x] Skrip uji sementara (hapus setelah selesai): UC-B penuh — rusak masuk (via refund RUSAK) → buat retur → `qty_damaged` berkurang, movement OUT tercatat → settle REFUNDED → settle ulang ditolak 409 → retur kedua WRITTEN_OFF → opex otomatis muncul ber-link → P&L tidak error
- [x] Uji HTTP level (routes+zod) di port uji terpisah
- [x] Regresi: `npm run e2e.sh` tetap hijau

---

## T4 — Opname Detail + Laporan Analisa

### T4.1 `opname.service.ts` — createOpname diperluas
- [x] Item input baru: `physical_qty_damaged?` (default = system damaged, tanpa adjustment), `cause?` ∈ `RUSAK|HILANG|SALAH_HITUNG|LAIN`
- [x] Baca system damaged dari `stock_batches.qty_damaged` (per batch / agregat per produk)
- [x] Selisih good → movement `ADJUSTMENT` condition GOOD; selisih damaged → `ADJUSTMENT` condition RUSAK (trigger T1 sudah otomatis arahkan ke `qty_damaged`)
- [x] Simpan `physical_qty_damaged` + `cause` di `stock_opname_items`

### T4.2 `getOpname` detail kaya
- [x] Per item: `unit_cost` (batch, fallback moving avg), **`value_difference` = selisih × unit_cost (Rp)**, `cause`, split good/damaged
- [x] Header: total selisih qty (good & damaged) + **total rugi/lebih Rp**
- [x] `listOpnames` ringkasan + total nilai selisih Rp per opname

### T4.3 `report.service.ts` — laporan analisa bulanan
- [x] `opnameReport(month)`:
  - [x] Total: frekuensi opname, Σ selisih qty good & damaged, Σ nilai selisih Rp
  - [x] Breakdown per `cause` dan per kategori produk
  - [x] Top 10 produk |nilai selisih| terbesar
  - [x] Tren 6 bulan terakhir (nilai selisih per bulan)
  - [x] Stok rusak belum diretur (Σ `qty_damaged` & nilai, plus retur `PENDING`)
- [x] Route `GET /reports/opname?month=YYYY-MM` — `requireRole('OWNER')`

### T4.4 `stock.service.ts`
- [x] `getStock`/`getProductStock`: tambah `qty_damaged` (+ `physical_total = remaining + damaged`)
- [x] `listMovements`: tampilkan kolom `condition` + filter query `condition`
- [x] `GET /alerts`: tambah indikator stok rusak (opsional bila trivial)

### T4.5 Verifikasi T4
- [x] `npm run typecheck` + `npm run build` bersih
- [x] Skrip uji sementara (hapus setelah selesai): UC-D — opname dengan selisih good −1 & damaged +1 + cause → 2 movement ADJUSTMENT beda condition, `qty_remaining`/`qty_damaged` benar → `GET /opnames/{id}` tampil `value_difference` Rp & cause → `/reports/opname` angka konsisten dengan data uji
- [x] Uji HTTP level + regresi e2e

---

## T5 — RBAC Matrix Penuh (OWNER read-only total)

### T5.1 `routes/index.ts` — mutasi = KASIR
- [x] Konstanta `KASIR = requireRole('KASIR')` & `OWNER = requireRole('OWNER')` (dideklarasi sekali, dipakai ulang)
- [x] `POST/PATCH/DELETE /products*` → KASIR
- [x] `POST/PATCH /categories*`, `POST /product-types` → KASIR
- [x] `POST/PATCH /customers*` → KASIR
- [x] `POST /purchases` → KASIR
- [x] `POST /sales`, `POST /sales/:id/payments`, `/void`, `/refund` → KASIR
- [x] `POST /opnames`, `POST /cash-sessions/open`, `POST /cash-sessions/:id/close` → KASIR
- [x] `POST/PATCH /expenses*` → KASIR (sebelumnya OWNER)
- [x] `POST/PATCH /payment-methods*`, `PATCH /store` → KASIR (sebelumnya OWNER)
- [x] `POST /supplier-returns`, `POST /supplier-returns/:id/settle` → sudah KASIR (dikonfirmasi, tidak diubah)
- [x] `GET /expenses`, `GET /expenses/:id`, `GET /reports/pnl|dashboard|opname` → tetap OWNER
- [x] Semua GET lain tetap terbuka untuk semua role (produk, kategori, tipe, customer, metode, pembelian, stock, movements, damaged, sales, receipt, cash-sessions, opnames, supplier-returns, store, alerts)
- [x] Handler TIDAK disentuh sama sekali (hanya `requireRole`)

### T5.2 Verifikasi T5
- [x] Harness matriks (88 assertion): KASIR 403 di `/reports/pnl|dashboard|opname`, `GET /expenses`, `GET /expenses/:id`
- [x] OWNER 403 di 23 endpoint mutasi (products/categories/product-types/customers/purchases/sales/payments/void/refund/opnames/cash-sessions/expenses/payment-methods/store/supplier-returns/settle/DELETE/PATCH)
- [x] KASIR TIDAK 403 di semua mutasi (role gate dilewati → 400 validasi / 404)
- [x] `login` + `/auth/me` tetap 200 untuk kedua role
- [x] Skenario 23 assertion di-e2e permanen (`scripts/e2e.sh` seksi "Matriks RBAC")

---

## T6 — P&L `refund_distributor` + bersihkan opex uji

### T6.1 DDL7 `0007_opex_is_test` (idempotent)
- [x] `ALTER TABLE operational_expenses ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false`
- [x] `CREATE INDEX IF NOT EXISTS idx_opex_is_test`
- [x] Dijalankan 2× berurutan → identik, data lama tidak berubah (hanya `npm run migrate`)

### T6.2 `pnlReport` — pendapatan lain
- [x] Field baru `refund_distributor` = Σ `supplier_returns.refunded_amount` WHERE `status='REFUNDED'` AND `refunded_at` di bulan tsb (TZ `env.businessTz`)
- [x] Arah benar: **pendapatan lain** → `laba_bersih = laba_kotor + refund_distributor − total_beban_operasional` (`laba_netto = laba_bersih`)
- [x] Kompatibilitas field lama dipertahankan (tidak ada field yang dihapus/berubah tipe)
- [x] `note` P&L diperbarui menjelaskan formula

### T6.3 Filter `is_test = false`
- [x] `pnlReport`: opex `WHERE is_test = false`
- [x] `listExpenses`: default sembunyikan opex uji; OWNER boleh `?include_test=true` (zod `expenseListSchema` + controller)
- [x] `getExpense`: `is_test` ikut dikembalikan di `ExpenseRow` (baris uji tetap bisa dibuka by-id)
- [x] `createExpense`/`updateExpense`: `is_test` bisa diisi dari context (default `false`)
- [x] `recordWriteOffExpense`: `is_test` diteruskan dari context pemanggil (default `false`)

### T6.4 `mark-test-data.ts` — opex uji
- [x] Aturan 1 (deterministik): opex `source='SUPPLIER_RETURN'` yang returnya item-nya memakai produk uji (nonaktif / sku `TEST-%`, `UJI%`, `TST-%`, `HTTPR%`) → `is_test=true`, **laporan per baris**
- [x] Aturan 2 (fallback konservatif): opex write-off `BARANG_RUSAK` yang dibuat hari ini (TZ bisnis)
- [x] Aturan 3: opex manual kategori berprefiks `TEST` (skenario RBAC e2e `TEST_RBAC`)
- [x] Ringkasan jumlah opex produksi tersisa (baris + Rp) di akhir
- [x] Aturan sale TIDAK diubah (predikat lama `is_active=false OR TEST-% OR UJI%`)

---

## T7 — OpenAPI + Docs sinkron

### T7.1 `openapi.yaml`
- [x] 5 path item baru → total **36 → 41** path (58 operation): `/stock/damaged`, `/supplier-returns` (GET+POST), `/supplier-returns/{id}`, `/supplier-returns/{id}/settle`, `/reports/opname`
- [x] Body refund/void disatukan ke `ReturnItemsInput` (`items[]`, `condition`, `qty`, `method_id`)
- [x] Schema: `SaleDetail.refund_items`, `ProductStock.qty_damaged/physical_total`, filter `damaged_only`, `Movement.condition` + filter `condition`, `DamagedStock`, `SupplierReturn(+Detail/Input/Settle)`, `ReturnItemsInput`
- [x] Opname: `physical_qty_damaged`, `system_qty_damaged`, `damaged_difference`, `cause`, `unit_cost`, `value_difference*`, `total_loss_value`/`total_gain_value`, + `OpnameReport`
- [x] Expenses: `source`, `supplier_return_id`, `is_test`, query `include_test`
- [x] PnlReport: `refund_distributor`, `ppn_diterima`, `total_refund`, `note`
- [x] Error codes baru didokumentasikan (`x-error-codes` + deskripsi response): `REFUND_QTY_EXCEEDED`, `REFUND_AMOUNT_EXCEEDED`, `VOID_ITEM_MISMATCH`, `DAMAGED_QTY_INSUFFICIENT`, `SUPPLIER_RETURN_SETTLED`, `FORBIDDEN`
- [x] Tag baru `Supplier Returns`; `info.version` 1.0.0 → 2.0.0 + deskripsi RBAC v2
- [x] Annotasi role di semua mutasi ("— KASIR only") & 403 OWNER
- [x] Validasi: YAML parse OK, 43 `$ref` / 0 broken, 0 operation tanpa `responses`

### T7.2 `fase.md`
- [x] Seksi baru "2b. Backend v2 — Refund Parsial, Stok Rusak, Retur Distributor, Opname Detail, RBAC": diagram alur barang rusak, tabel fitur, tabel RBAC, tabel error baru
- [x] Checkbox FASE 0–7 → `[x]` (sudah terimplementasi via API; FASE 8 sudah `[x]`)
- [x] FASE 8 diperbarui (input opex = KASIR, `refund_distributor`)
- [x] Referensi plan v2 + jumlah path openapi

### T7.3 `test_usecase.md`
- [x] Use case asal tetap, ditambah catatan perubahan RBAC
- [x] UC-A refund parsial barang rusak, UC-B retur distributor (REFUNDED & WRITTEN_OFF), UC-C void berlabel, UC-D opname detail + laporan — lengkap dengan angka harapan

---

## T8 — E2E permanen UC A–D + role matrix

### T8.1 `scripts/e2e.sh` — penyesuaian RBAC
- [x] `TOKEN` default diganti ke **kasir** (semua mutasi); `OWNER_TOKEN` dipakai untuk `/reports/*`, `GET /expenses`, `auth/me`
- [x] `b8` jadi "kasir create method 201"; `b10` dibalik jadi "owner create method → 403"
- [x] `x8`/`x9` (dokumentasi) tidak lagi hardcode port 3000 → mengikuti `API`
- [x] `a10`–`a13`: `/auth/me` 200 + role benar untuk kedua role

### T8.2 Suite UC (urutan A → C → D → B, stok & rusak dipakai bersama)
- [x] **UC-A** (A1–A20): jual 3 + CASH lunas → refund 1 RUSAK (uang 15000, `refund_items`, `qty_damaged` naik, movement `RETURN`/RUSAK, status tetap COMPLETED) → refund melebihi sisa `422 REFUND_QTY_EXCEEDED` → refund penuh (45000, `RETURNED`, stok balik)
- [x] **UC-C** (C1–C15): jual 2 gula + 1 voucher UNPAID → void dengan condition campuran (gula RUSAK, voucher GOOD) → label note movement berbeda, kolom stok berbeda
- [x] **UC-D** (D1–D25): opname selisih GOOD −0.5 + RUSAK −1 dengan `cause` → `unit_cost`, `value_difference`, `value_difference_damaged`, `value_difference_total`, `total_loss_value`, 2 movement ADJUSTMENT beda condition (filter `reference_id` opname) → detail `/opnames/{id}`
- [x] **UC-B** (B1–B30): `GET /stock/damaged` → retur #1 PENDING (`qty_damaged` −, movement OUT SUPPLIER_RETURN) → `409 DAMAGED_QTY_INSUFFICIENT` → settle REFUNDED (uang + `refunded_at`) → settle ulang `409 SUPPLIER_RETURN_SETTLED` → retur #2 WRITTEN_OFF → opex otomatis ter-link (`write_off_expense`)
- [x] **P&L** (P1–P7): `refund_distributor` muncul & > 0, `note` memuat formula, `/reports/opname` OWNER punya item + blok `stok_rusak_belum_diretur`
- [x] **Matriks RBAC** (R1–R18): kasir 403 `/reports/*` + `GET /expenses{,/:id}`, kasir boleh input opex & master, owner 403 semua mutasi, owner tetap baca semua GET + laporan, `/auth/me` keduanya

### T8.3 Pembersihan
- [x] Nonaktifkan produk uji (gula, voucher, produk RBAC) + nonaktifkan metode uji (token kasir)
- [x] Opex uji `POST /expenses` diverifikasi terbaca OWNER, lalu ditandai `is_test` oleh `mark-test-data`
- [x] `mark-test-data` dijalankan otomatis di akhir skrip (gagal = FAIL)
- [x] Cek regresi data asli berbasis **delta** (stok produk id=1 sebelum vs sesudah) + batch produksi dicari per `batch_code` (bukan index 0) supaya tahan batch lain
- [x] Lama skrip tetap wajar (~2 detik; total 245 assertion)

### T8.4 Verifikasi T8
- [x] `npm run typecheck` + `npm run build` bersih
- [x] `npm run migrate` (DDL7) 2× idempotent
- [x] `npm run e2e` → **245 PASS / 0 FAIL**
- [x] `npm run concurrency` → 18/18, 0 oversell
- [x] P&L: opex uji tidak tampil default, `refund_distributor` benar untuk bulan berjalan
- [x] `npm run mark-test-data` + server uji (port 3100) dimatikan + file sementara dihapus

---

## Berikutnya (T5–T9 selesai)
- [x] **T5** RBAC matrix penuh (owner read-only semua mutasi) — `routes/index.ts`
- [x] **T6** P&L `refund_distributor` + opex `is_test` — `report.service.ts`, `expense.service.ts`, `migrate.ts` (0007)
- [x] **T7** OpenAPI + `fase.md` + `test_usecase.md` sinkron
- [x] **T8** E2E permanen UC A–D + matriks RBAC — `scripts/e2e.sh`
- [x] **T9** `supplier_returns.is_test` + filter P&L — `migrate.ts` (0008), `report.service.ts`, `supplier-return.service.ts`, `mark-test-data.ts`
- [x] **T9** OpenAPI tanpa restart — `app.ts` (cache mtime)

## Catatan global
- ⚠️ Server produksi port 3000 (PID 66980) masih kode lama — **restart setelah T3/T4** sebelum dipakai.
- Selalu `npm run backup` sebelum uji yang menulis ke DB; akhiri uji dengan `npm run mark-test-data`; jalankan server uji di port terpisah (mis. 3100).
- JANGAN git commit; JANGAN DROP/DELETE data; DDL hanya idempotent.

---

## Catatan T3/T4 (deviasi & temuan)

### DDL6 `0006_opname_damaged_snapshot` (idempotent, sudah di-migrate)
- `stock_opname_items.system_qty_damaged numeric(14,3) NOT NULL DEFAULT 0` — **diperlukan**: snapshot stok rusak saat opname. Tidak bisa dibaca ulang saat detail/report karena stok bergerak terus; laporan bulan lalu tidak boleh berubah karena penjualan sesudahnya. Kolom `physical_qty_damaged` saja tidak cukup (nullable, bisa diisi = sistem).
- `stock_opname_items.damaged_difference` generated column `COALESCE(physical_qty_damaged, system_qty_damaged) - system_qty_damaged` — nullable legacy (`NULL` = opname lama tanpa hitung barang rusak) aman.
- `supplier_returns.refund_reference_no text` — spec §2 UC-B menyebut `reference_no?` di body settle, tapi tabel 0005 tidak punya kolomnya. Ketidaksesuaian spec↔DDL ini ditutup di DDL6.
- `operational_expenses.source` **diperlebar varchar(12) → varchar(20)**. **BUG DDL5**: nilai yang dipakai opex write-off adalah `'SUPPLIER_RETURN'` (15 karakter) > 12 → `22001 value too long`. Tanpa perbaikan ini settle `WRITTEN_OFF` selalu gagal.

### Penyimpangan kecil dari plan/tasklist
- `settleSupplierReturn` tidak memvalidasi `requires_reference` untuk `BANK_TRANSFER` (tidak ada kolom `reference_no` pada tabel `payments` untuk retur distributor; reference_no opex *opsional* di spec). Field tetap disimpan bila dikirim.
- `batch_id` dobel dalam 1 request ditolak `VALIDATION_ERROR` (bukan digabung) agar `unit_cost` per baris tidak ambigu.
- Scope idempotency settle memakai id konkret (`POST /supplier-returns/{id}/settle`), bukan template, supaya 1 key tidak me-replay response retur lain.
- `per_cause` / `per_kategori` / `top_produk` di `/reports/opname` menampilkan `selisih_qty` (GOOD) **dan** `selisih_qty_damaged` terpisah, bukan net — net saja menyembunyikan komposisi (mis. good −1 + damaged +1 = 0 padahal ada 2 selisih nyata).
- `listOpnames`/`getOpname` mengembalikan `total_value_difference` (net) + `total_loss_value`/`total_gain_value` (rugi/lebih mutlak).
- `GET /stock?damaged_only=true` ditambahkan (Trivial,ibol 4) untuk layar "siap diretur" tanpa perlu paginasi semua stok.
- `GET /alerts` dapat `damaged_stock` + `damaged_stock_total` (Trivial 4, "opsional bila trivial" — tetap dikerjakan karena 1 query).

### Sisa data uji di DB (tidak dihapus — kebijakan no DELETE)
- ~~`operational_expenses` kategori `BARANG_RUSAK` dari uji T3 **ikut tampil di P&L** karena tabel ini tidak punya flag `is_test` (hanya `sales` yang punya).~~ **SELESAI di T6** — DDL7 menambah `operational_expenses.is_test`; `pnlReport` & `listExpenses` memfilternya, `npm run mark-test-data` menandainya.
- Produk uji nonaktif + sale uji sudah ditandai `is_test=true` oleh `npm run mark-test-data` (19 sale).

---

## Catatan T5–T8 (deviasi, temuan & pemulihan data)

### DDL7 `0007_opex_is_test` (idempotent, sudah di-migrate 2×)
- `operational_expenses.is_test boolean NOT NULL DEFAULT false` + `idx_opex_is_test` — tabel opex dibuat manual di luar migration, jadi tidak punya padanan `sales.is_test` (0003). Tanpa ini P&L tercemar opex write-off dari skrip uji.
- Default `false` → opex produksi tidak tersentuh; hanya ditandai `npm run mark-test-data`.

### Penyimpangan dari plan
- ~~**`supplier_returns` tidak diberi `is_test`.** `refund_distributor` memakai definisi spec apa adanya (Σ `refunded_amount` status REFUNDED per `refunded_at`), jadi **masih memuat retur uji** (per 2026-10: Rp110.000 dari 8 retur uji T3/T4). Tabel retur tidak punya flag uji — usul T9. Opex write-off sudah bersih (punya `is_test`).~~ **SELESAI di T9** — DDL8 menambah `supplier_returns.is_test`; `pnlReport` memfilternya (`?include_test=true` untuk melihat), `npm run mark-test-data` menandainya. Angka aktual setelah T9: Rp140.000 dari 12 retur uji T3/T4+e2e → `refund_distributor` produksi = **Rp0**.
- ~~Aturan `mark-test-data` untuk sale **tidak diperluas** ke prefiks `TST-%`/`HTTPR%` (tetap `is_active=false OR TEST-% OR UJI%`) agar tidak mengubah semantik penandaan yang sudah dipakai. Konsekuensi: 3 produk uji T3/T4 yang masih `is_active=true` membuat sale uji-nya belum ditandai → Usulan T9: samakan predikatnya.~~ **SELESAI di T9** — predikat sale diperluas `+ TST-%` `+ HTTPR%`; sale uji dari produk T3/T4 yang masih aktif ikut ditandai.
- P&L 41 path di `openapi.yaml` (bukan 42): `GET`+`POST /supplier-returns` berbagi satu path item. 58 operation total. (T9: versi spec 2.0.0 → 2.1.0.)
- ~~`openapi.json` di-cache saat boot (`loadOpenApi()` di `src/app.ts`) → **server wajib di-restart** setiap `openapi.yaml` berubah.~~ **SELESAI di T9** — cache sekarang kunci `mtime`+`size` dan re-read hanya saat berubah; spec invalid tetap jatuh ke cache lama + warning.

### Perbaikan pada `scripts/e2e.sh`
- Token default = **kasir** (semua mutasi), `OWNER_TOKEN` khusus laporan; `b10` dibalik jadi "owner create method → 403".
- Cek regresi data asli diubah dari angka tetap (`16`) menjadi **delta** sebelum/sesudah + pencarian batch per `batch_code`. Alasannya: ada klien lain (POS/agen lain) yang sesekali memakai produk id=1, sehingga angka absolut tidak bisa dijadikan guard. Guard delta justru lebih kuat: membuktikan e2e tidak mengubah data produksi.
- Cek `D19` (jumlah movement ADJUSTMENT) di-filter per `reference_id` opname supaya deterministik pada e2e yang diulang.
- `x8`/`x9` tidak lagi hardcode port 3000 → mengikuti `API` (port server uji).
- `mark-test-data` dijalankan di akhir skrip; kegagalan = FAIL.

### ⚠️ Insiden: data produksi sempat berubah & cara memulihnya
Verifikasi awal T5 memakai harness bash yang salah (body JSON rusak karena ekspansi `${B:+-d \"$B\"}`), sehingga beberapa request benar-benar sempat dieksekusi:
| Dampak | Pemulihan (tanpa DELETE/DROP) |
|---|---|
| `sales` #1 (INV-20261004-001, UNPAID) ter-void | `ALTER TABLE sales DISABLE TRIGGER trg_sales_void` → `UPDATE` status kembali `COMPLETED` + void metadata NULL → trigger di-enable lagi (1 transaksi) |
| Void membuat movement `IN +4` (batch 1: 16 → 20) | Insert movement `ADJUSTMENT -4` `reference_type='CORRECTION'` → batch 1 kembali 16, ledger tetap konsisten |
| `POST /purchases` uji membuat batch 60 (1 @ Rp1) + movement `IN +1` | Insert movement `ADJUSTMENT -1` pada batch 60 → `qty_remaining=0` (baris tetap ada, ledger tidak dihapus) |
| Trigger `trg_batch_update_product_cost` menimpa `product` #1 `harga_beli` → Rp1 | `UPDATE product SET harga_beli = 40000` (nilainya dipulihkan dari backup pra-uji) |
| `PATCH /store` uji menimpa nama toko | `UPDATE store_profile SET name = 'Toko Berkah Digital'` (dari backup pra-uji) |
| Produk/kategori/tipe/customer/metode uji, opex `RBAC_UJI`, cash session uji | Soft: `is_active=false` / nama diberi suffix `(nonaktif)` / `is_test=true` / cash session ditutup via API |

Semua tindakan tercatat di ledger `CORRECTION` (movement 363–364) dan diverifikasi ulang: sale #1 `COMPLETED`, stok total produk #1 = 16, `harga_beli` 40000, nama toko asli. **Tidak ada baris yang di-DELETE atau di-DROP.** Harness verifikasi T5–T8 setelah itu dipindah ke TypeScript (payload di-`JSON.stringify`) sehingga tidak mungkin merusak body lagi.

---

## T9 — Pembersihan Akhir Plan v2

### T9.1 `supplier_returns.is_test` + filter P&L
- [x] DDL8 `0008_supplier_return_is_test` (idempotent): `supplier_returns.is_test boolean NOT NULL DEFAULT false` + **partial index** `idx_supplier_returns_is_test (refunded_at) WHERE is_test = false AND status = 'REFUNDED'` (index hanya berisi retur produksi — persis yang dibutuhkan `pnlReport`)
- [x] `pnlReport(month, { includeTest })`: `refund_distributor` filter `is_test = false`; `?include_test=true` membuka lagi seluruh data uji (sales + opex + retur) — konsisten dengan `GET /expenses` & `GET /sales`
- [x] Zod: `pnlQuerySchema.include_test` (`boolish`); `opnameReportQuerySchema` dipisah (tidak ikut mewarisi `include_test` yang tidak relevan)
- [x] `createSupplierReturn`: insert kolom `is_test` (`COALESCE($6, false)`), kolom opsional di body zod
- [x] `settleSupplierReturn` meneruskan `is_test` retur ke `recordWriteOffExpense` → **opex write-off mewarisi tanda retur** (tidak perlu ditandai 2×)
- [x] `SELECT_RETURN` mengembalikan `is_test` (terekspos di list & detail)
- [x] `openapi.yaml` v2.1.0: `SupplierReturn.is_test`, `SupplierReturnInput.is_test` (opsional), query `include_test` di `/reports/pnl`, deskripsi `refund_distributor`
- [x] **Retur uji yang ada ditandai: 27/27** (`refund_distributor` produksi 2026-10: **Rp140.000 → Rp0**; `?include_test=true` → Rp140.000)
- [x] `scripts/e2e.sh` UC-B: `supplier_name` → prefiks `TEST-Distributor` (deterministik untuk `mark-test-data`)

### T9.2 Perluas predikat `mark-test-data`
- [x] Aturan sale: + `TST-%` dan `HTTPR%` (skrip uji T3/T4 & uji HTTP)
- [x] Blok baru `markSupplierReturns()` — 3 predikat OR, dilaporkan per `return_no`
- [x] Ringkasan akhir: sale produksi tersisa, opex produksi tersisa, **retur produksi tersisa**
- [x] Hasil: 6 sale + 27 retur + 1 opex (jalur T3/T4) di run pertama; 2 retur + 1 opex + 1 opex manual di run e2e; 11 sale di run akhir (concurrency)

### T9.3 OpenAPI tanpa restart (cache mtime)
- [x] `loadOpenApi()`: `statSync` (mtime + size) tiap request; re-read + re-parse hanya saat berubah
- [x] Perilaku terjaga: spec invalid → cache lama tetap dipakai + `console.warn`; boot tetap gagal cepat kalau tidak ada cache sama sekali
- [x] `/openapi.json` memakai cache terbaru; swagger UI diarahkan ke `/openapi.json` (`swaggerOptions.url`) supaya tidak lagi memakai spec inline saat boot
- [x] Uji: ubah `info.title` → `GET /openapi.json` berubah **tanpa restart** (PID sama); spec rusak → 200 + spec lama + warning; file dipulihkan (identik dengan backup)

### T9.4 Verifikasi T9
- [x] `npm run backup` → `backups/inventory_db_20261004_102500.dump` (128K)
- [x] `npm run typecheck` + `npm run build` bersih
- [x] `npm run migrate` 2× → DDL8 idempotent, data lama utuh
- [x] `npm run e2e` (server uji port 3100) → **251 PASS / 0 FAIL** (245 + 6 assertion baru: B8b/B8c/B29b/P3b/P3c/P3d)
- [x] `npm run concurrency` → **19 PASS / 0 FAIL**, 0 oversell (stok akhir 0, rekonsiliasi ledger 0)
- [x] P&L bulan berjalan: default `refund_distributor=0` (produksi murni), `?include_test=true` = Rp160.000
- [x] Uji cache openapi (lihat T9.3) → PASS, file `openapi.yaml` dipulihkan
- [x] `npm run mark-test-data` → server uji dimatikan, file sementara dihapus
- [x] Validasi `openapi.yaml`: 41 path, 58 operation, 0 broken `$ref`, 0 operation tanpa `responses`

### Catatan T9 (deviasi & temuan)

**Predikat retur uji melebar dari 2 menjadi 3.** Rencana menyebut kandidat
`supplier_name ILIKE 'TEST%'` ATAU `id IN (opex is_test=true)`. Inspeksi data menunjukkan kedua
predikat itu hanya menutup **15 dari 27** retur (8 + 11 − 4 irisan) dan **8 dari 12 retur uji
berstatus REFUNDED** ikut terlewat — semuanya punya `supplier_name` 'DISTRIBUTOR UJI' / 'DIST HTTP'
(tidak berawalan `TEST`) dan tidak punya opex (PENDING/REFUNDED tidak menghasilkan opex). Kalau
hanya dua predikat itu, `refund_distributor` produksi tetap tercemar ±Rp90.000 — melanggar
syarat "turun ke nilai produksi murni". Maka ditambah predikat ketiga yang deterministik:
**item retur memakai produk uji** (predikat produk yang sama dengan aturan opex write-off).
Hasil inspeksi: **0 dari 27 retur** lolos ketiga predikat → semua 27 retur uji, tanpa ada
retur produksi yang ikut ditandai (produk produksi `PRD-TSEL-10GB` / `PRD-TRI-20GB` /
`PRD-VCH-7GB` tidak cocok predicate mana pun).

**`include_test` di `/reports/pnl` berlaku untuk SELURUH laporan, bukan hanya `refund_distributor`.**
Sales, refunds, opex, `refund_distributor` dan `piutang_berjalan` ikut membuka filter yang sama
sekaligus — membuka hanya sebagian (mis. hanya retur uji ikut hitung) akan menghasilkan P&L
yang tidak konsisten (pendapatan masuk tanpa HPP-nya). Default (tanpa param) tidak berubah
sama sekali.

**Opex write-off mewarisi `is_test` retur.** Plan tidak menyebut ini, tapi tanpa itu setiap
settle `WRITTEN_OFF` dari retur uji tetap perlu ditandai manual di `operational_expenses` —
yaitu sumber kontaminasi P&L yang sama persis. Sekarang cukup satu penandaan.

**`GET /supplier-returns` tidak disembunyikan `is_test` secara default** (tidak diminta; tidak
diubah agar tidak mengubah perilaku read yang sudah dipakai). `is_test` tetap terekspos di
respons, jadi klien bisa memfilter sendiri. Kalau mau konsisten penuh dengan
`GET /sales` & `GET /expenses`, tinggal tambahkan `include_test` (default `false`) — **tidak
dikerjakan di T9** karena di luar daftar item T9.

**E2E dijalankan ke server uji port 3100, bukan port 3000.** Port 3000 masih menjalankan kode
T1–T8 (belum ada kolom `is_test` di SELECT retur / filter P&L), jadi assertion baru `B8c`/`B29b`
pasti gagal di sana. Sesuai batasan "JANGAN sentuh proses port 3000", e2e & concurrency
dijalankan ke `APP_PORT=3100 npx tsx src/server.ts` (build terbaru), lalu dimatikan.

**Produk uji yang masih `is_active=true` (tidak diubah, hanya dilaporkan).** Setelah inspeksi
manual: 37 `TEST-UC-UC304898`, 38 `TEST-UC-UC313503`, 46 `TST-TR-UJE370649`,
47 `TST-TR-UJE385732`, 48 `TST-TR-UJE399736`, 52 `HTTPR-H095323`. Verifikasi silang: **0** dari
produk ini dipakai sale produksi (`n_sale_produksi = 0` untuk semuanya), jadi sale uji-nya
sudah/mark-able aman. Penonaktifannya TIDAK dilakukan (di luar item T9 — `is_active=false` memang `UPDATE`, tapi
mengubahnya diam-diam adalah keputusan saya, bukan bagian dari T9). Rekomendasi: nonaktifkan
juga agar tidak muncul di daftar produk POS dan tidak dipakai transaksi baru.

**Sale ambigu yang SENGAJA tidak ditandai.** `INV-20261004-315` (id 325, Rp55.000) dan
`INV-20261004-316` (id 326, Rp25.000) — keduanya `created_by=owner` 10:23, UNPAID, itemnya
**produk produksi** (`PRD-TSEL-10GB`, `PRD-TRI-20GB`). Keduanya sisa harness bash T5 yang
payloadnya rusak (kejadian yang tercatat di catatan insiden T5). Tidak cocok predicate uji
mana pun dan tidak bisa dipastikan data uji tanpa asumsi → **tidak ditandai, dilaporkan di
sini**. Dampaknya: `pendapatan` P&L produksi 2026-10 masih memuat Rp80.000 dari 2 sale itu.
Penanganannya perlu keputusan OWNER (void via API, atau `UPDATE sales SET is_test = true`
dengan ID eksplisit).

**Temuan sampingan (bukan regresi T9):** aset statis swagger UI (`swagger-ui-init.js`,
`swagger-ui-bundle.js`, `swagger-ui.css`) sudah **404** baik di port 3000 (kode lama) maupun
port 3100 (kode baru) — jadi `/api-docs` memang tidak berfungsi sudah sebelumnya T9. Yang
dipakai mesin (`GET /openapi.json`) sehat. Tidak disentuh di T9.



