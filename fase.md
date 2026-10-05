# Fase Implementasi — POS Inventory (Multi POS / Multi User)

> DB: PostgreSQL 16 `inventory_db@139.190.100.175:5432`
> Prinsip: **tanpa VIEW** (semua baca stok via query langsung), ledger immutable, ACID penuh untuk konkurensi 2+ POS.
> **API only — tanpa frontend** (integrasi via Swagger `/api-docs`).

## Status Hardening (P0/P1/P2) — SELESAI
- **P0**: `user_account.role` di DB (login baca role DB, .env hanya fallback) · data uji `sales.is_test` (report/list otomatis filter, `npm run mark-test-data`) · backup harian `scripts/backup.sh` (cron, retensi 14 hari) · PM2 `ecosystem.config.js` · README go-live checklist (firewall/SSL DB wajib disetel di sisi server — tindakan infrastruktur).
- **P1**: **refund** `POST /sales/{id}/refund` (PAID→RETURNED + tabel `refunds`, void PAID tetap ditolak) · **sesi kasir** `/cash-sessions` (open/close, expected = awal + CASH masuk − refund CASH, selisih otomatis) · **auth** refresh token + logout revoke + rate limit (login 10/15m, global 600/m) .
- **P2**: PPN `tax_percent` per transaksi · konversi satuan jual (`product.unit_conversions`, harga per satuan ALT) · `GET /alerts` (min_stock & expired ≤30 hr) · `GET /reports/dashboard`.

---

## 0. Kondisi Database Saat Ini

### Tabel (13)
| Tabel | Fungsi |
|---|---|
| `product_type`, `product_category`, `product` | Master produk (`attributes JSONB`, `barcode`, `harga_beli`, `harga_jual`) |
| `stock_batches` | Barang masuk per batch/GRN (`unit_cost`, `expired_date`, `qty_received/qty_remaining NUMERIC(14,3)`) |
| `stock_movements` | Ledger stok immutable (IN/OUT/ADJUSTMENT, `qty_change NUMERIC(14,3)`) |
| `sales` | Header penjualan (`status`, `payment_status`, void metadata) |
| `sale_items` | Detail penjualan (`qty NUMERIC(14,3)`, snapshot `unit_cost`, `batch_id NOT NULL`) |
| `payment_methods` | Master metode bayar (configurable via menu: CASH, BANK_TRANSFER, dst.) |
| `payments` | Pembayaran **partial** multi-row per sale (`tendered_amount`, `change_amount` generated) |
| `stock_opnames` + `stock_opname_items` | Opname harian (system vs physical) |
| `customer`, `user_account` | Relasi & kasir |

### Guard DB (sudah aktif)
- Anti-oversell: `FOR UPDATE` lock batch di `fn_sale_item_validate`
- Auto-deduct stok: `trg_sale_item_apply_movement`
- Harga jual >= harga beli (snapshot per batch)
- Overpay ditolak; `payment_status` auto-sync (UNPAID/PARTIAL/PAID)
- Void auditable: `COMPLETED → VOIDED/RETURNED` + movement IN balik; void ditolak jika sudah dibayar
- Ledger & transaksi tidak bisa di-UPDATE/DELETE

### Query stok pengganti VIEW (WAJIB pakai ini)
```sql
SELECT p.id, p.sku, p.barcode, p.name, p.unit,
       COALESCE(SUM(b.qty_remaining), 0)::numeric(14,3) AS qty_on_hand,
       MIN(b.expired_date) AS nearest_expiry
FROM product p
LEFT JOIN stock_batches b ON b.product_id = p.id
GROUP BY p.id, p.sku, p.barcode, p.name, p.unit;
```

---

## 1. Strategi ACID Multi-POS / Multi User

| Aspek | Implementasi |
|---|---|
| **Atomicity** | 1 penjualan = 1 DB transaction: `BEGIN → INSERT sales → INSERT sale_items (trigger deduct) → INSERT payments → COMMIT`. Gagal di tengah = ROLLBACK total, stok & tagihan konsisten. |
| **Consistency** | Semua rule di DB (CHECK + trigger): stok tidak minus, jual < harga beli ditolak, overpay ditolak, `qty_remaining` selalu = `qty_received` − OUT + VOID-IN. Aplikasi tidak boleh menghitung stok sendiri. |
| **Isolation** | `READ COMMITTED` + `SELECT ... FOR UPDATE` pada `stock_batches` (sudah di trigger). Dua POS menjual batch sama → serialized by row lock, kedua-kali sukses selama stok cukup; jika kurang → `ERROR: Stok tidak cukup batch ...` (HTTP 409). |
| **Durability** | PostgreSQL WAL default (`synchronous_commit=on`). Jangan dimatikan. |

### Aturan wajib aplikasi multi-POS
1. **Connection pool per instance** (mis. pool size 10), jangan 1 koneksi global.
2. **Idempotency-Key** (UUID dari klien) di header `POST /sales` & `POST /payments` → simpan di tabel `idempotency_keys(key, response, created_at)` atau cache; mencegah double-submit saat network retry.
3. **Nomor transaksi** dari SEQUENCE DB (bukan timestamp max+1) → `sale_no` unik walau 2 POS submit bersamaan.
4. **Retry policy**: retry hanya jika error connection/serialization; error business (409 stok/harga) TIDAK di-retry.
5. **Waktu server**: semua `paid_at/created_at` dari DB `now()`, bukan jam mesin POS.
6. **Login kasir wajib** → `user_account` dipakai untuk `sales.created_by`, `payments.received_by`, `voided_by`.

---

## 2. Fase Implementasi

### FASE 0 — Fondasi (1–2 hari)
- [x] Setup repo backend + koneksi DB dari `.env` (pool, timeout, SSL opsional)
- [x] Migration manager (idempotent, forward-only: `src/db/migrate.ts` 0001–0007) — import `inventory_pos_migration_v2.sql` sebagai baseline
- [x] Seed: minimal 2 `user_account` (owner, kasir1) + role sederhana (OWNER/KASIR) — role disimpan di DB (`user_account.role`)
- [x] Isi data rekening `payment_methods` BANK_TRANSFER yang asli
- [x] Auth: login JWT + refresh token, middleware role
- **Done when:** login dapat token, pool connect, migration `up` jalan. ✅

### FASE 1 — Master Data & Menu (2–3 hari)
- [x] CRUD produk (barcode scan-friendly: cari by barcode/sku), kategori, tipe
- [x] CRUD `payment_methods` (aktif/nonaktif, rekening bank) — inilah "set di menu"
- [x] CRUD customer (opsional untuk walk-in)
- **Endpoints:** `GET/POST /products`, `GET/PATCH/DELETE /products/{id}`, sama untuk categories, payment-methods
- **Done when:** bisa tambah produk minimarket (kg/ml/pcs) & metode QRIS via menu. ✅

### FASE 2 — Pembelian / Barang Masuk (2 hari)
- [x] Form beli bulk → 1 `stock_batches` + movement IN otomatis (transaksi tunggal)
- [x] Expired date opsional; harga beli per batch
- [x] List batch + stok per batch (query langsung, tanpa view)
- **Endpoints:** `POST /purchases`, `GET /purchases`, `GET /stock?product_id=`
- **Done when:** beli 20 pcs kartu @40.000 exp 2026-10-11 → batch 20, ledger IN +20. ✅

### FASE 3 — Penjualan POS / Barang Keluar (3–4 hari)
- [x] Layar kasir: scan → keranjang → bayar (Fixed price = default `harga_jual`; nego diizinkan, < harga beli diblok DB)
- [x] `POST /sales` atomic: header + items + payment pertama dalam 1 transaksi DB
- [x] Idempotency-Key + `sale_no` dari sequence
- [x] Mapping error DB → HTTP: stok kurang/harga di bawah beli = `409`
- **Done when:** jual 4 pcs @50.000 → stok 16, `payment_status` benar (PAID jika lunas, PARTIAL jika DP). ✅

### FASE 4 — Pembayaran Partial & Multi Metode (2–3 hari)
- [x] `POST /sales/{id}/payments` (DP/pelunasan, CASH dengan tendered→change, BANK_TRANSFER wajib `reference_no`)
- [x] Daftar pembayaran per sale + sisa tagihan
- [x] Cetak/struk sederhana (`GET /sales/{id}/receipt` JSON untuk render FE)
- **Done when:** AT-2 s/d AT-4 & AT-8 dari acceptance DB lulus lewat API. ✅

### FASE 5 — Void / Retur (2 hari)
- [x] Void sale UNPAID (alasan wajib, stok kembali via movement IN berlabel kondisi GOOD/RUSAK)
- [x] Retur/refund per item untuk sale PAID (status `RETURNED`, uang di tabel `refunds`, boleh parsial)
- [x] Tidak ada endpoint delete sale/item — ledger immutable
- **Done when:** AT-6, AT-7 lulus via API; tidak ada endpoint delete sale/item. ✅

### FASE 6 — Stok Opname Harian (2 hari)
- [x] Form opname: generate system_qty GOOD + system_qty_damaged RUSAK otomatis (query langsung), input physical
- [x] Movement ADJUSTMENT otomatis per kondisi (selisih GOOD & selisih RUSAK), termasuk `cause` selisih
- [x] Riwayat opname + rekap selisih (nilai rupiah per item & per opname)
- **Endpoints:** `POST /opnames`, `GET /opnames?date=`, `GET /opnames/{id}`, `GET /reports/opname?month=` (OWNER)
- **Done when:** opname harian tersimpan, selisih tercatat, stok terkoreksi (GOOD & RUSAK). ✅

### FASE 7 — Hardening Multi-POS (2–3 hari)
- [x] Uji beban 2 terminal simulasi: `npm run concurrency` — 0 oversell, 0 stok minus
- [x] Idempotency-Key diverifikasi (retry tidak dobel transaksi)
- [x] Audit log aplikasi (who/when) untuk semua mutasi
- [x] Backup harian `pg_dump` + retensi; monitor koneksi pool (`/health`, PM2)
- **Done when:** skenario 2 POS bersamaan bersih tanpa inkonsistensi stok/kas. ✅

### FASE 8 — Pengeluaran Operasional & Laba Bersih/Netto (SELESAI)
- [x] Tabel `operational_expenses` (migration 0002): category dinormalisasi, `amount > 0`, audit created/updated
- [x] `GET/POST /expenses`, `GET/PATCH /expenses/{id}` — ~~input = KASIR, baca/laporan = OWNER~~ → **amandemen FE-11: input + baca = OWNER** (kasir 403 di keempatnya)
- [x] `GET /reports/pnl?month=YYYY-MM` — OWNER-only: pendapatan, HPP, laba kotor, beban per kategori, `refund_distributor`, **laba bersih = laba kotor + refund_distributor − opex**, laba netto, piutang berjalan. Basis akrual (sales COMPLETED periode, TZ Asia/Jakarta)
- **Done when:** kasir input gaji/listrik/internet → P&L ter-update; owner bisa baca, kasir tidak. ✅

---

## 2b. Backend v2 — Refund Parsial, Stok Rusak, Retur Distributor, Opname Detail, RBAC

> Spec lengkap: `plan-backend-v2-refund-rusak-opname-rbac.md` · Eksekusi: `tasklist-backend-v2.md` (T1–T8)
> Migrasi `0005` (stok rusak + refund parsial + retur distributor + opname detail) dan `0006` (snapshot opname rusak), `0007` (flag `is_test` pada opex).

### Alur barang rusak
```
BARANG RUSAK (refund/void berlabel RUSAK)
   → masuk qty_damaged (KARANTINA, tidak pernah ikut terjual POS)
   → GET /stock/damaged (siap diretur, per batch)
   → POST /supplier-returns (movement OUT condition RUSAK, qty_damaged −)
   → POST /supplier-returns/{id}/settle:
        REFUNDED    → uang masuk → P&L `refund_distributor` (pendapatan lain)
        WRITTEN_OFF → otomatis jadi opex `BARANG_RUSAK` (source SUPPLIER_RETURN)
```

| Fitur | Endpoint / kolom | Catatan |
|---|---|---|
| Refund parsial | `POST /sales/{id}/refund` + `items[{sale_item_id, qty, condition}]` | Tanpa `items` = refund penuh semua GOOD (kompatibel FE lama). Parsial → status tetap `COMPLETED`; semua habis → `RETURNED` |
| Void berlabel | `POST /sales/{id}/void` + `items[{sale_item_id, condition}]` | GOOD → `qty_remaining`, RUSAK → `qty_damaged` |
| Detail refund | `refund_items` pada `GET /sales/{id}` | qty, kondisi, snapshot harga, subtotal |
| Stok rusak | `GET /stock/damaged`, `qty_damaged` + `physical_total` di `/stock`, filter `?damaged_only=true` | `qty_on_hand` tetap HANYA barang GOOD |
| Ledger kondisi | `stock_movements.condition` (GOOD/RUSAK) + filter `?condition=` | 2 jejak audit terpisah: masuk rusak & retur distributor |
| Retur distributor | `POST/GET /supplier-returns`, `GET /supplier-returns/{id}`, `POST /supplier-returns/{id}/settle` | No. dokumen `RTR-YYYYMMDD-NNN` dari sequence; Idempotency-Key wajib |
| Opex otomatis | `operational_expenses.source='SUPPLIER_RETURN'` + `supplier_return_id` | Ditulis dalam transaksi settle yang sama (atomik) |
| Opname detail | `physical_qty_damaged`, `cause`, `unit_cost`, `value_difference*` | Snapshot `system_qty_damaged` (0006) supaya laporan bulan lalu tidak berubah |
| Laporan opname | `GET /reports/opname?month=YYYY-MM` (OWNER) | per cause, per kategori, top 10 produk, tren 6 bulan, stok rusak belum diretur |
| P&L | `refund_distributor` | = Σ `refunded_amount` retur status REFUNDED per `refunded_at` (TZ Asia/Jakarta) |
| Data uji | `operational_expenses.is_test` + `?include_test=true` | Opex uji disembunyikan dari daftar default & P&L; `npm run mark-test-data` |

### RBAC (keputusan final plan §8) — **+ amandemen FE-11 (revisi user)**
> **Amandemen FE-11:** pengeluaran operasional (`/expenses`) menjadi **OWNER sepenuhnya** —
> input (`POST`/`PATCH`) ikut pindah ke OWNER, bukan hanya baca. KASIR tidak punya menu
> maupun kapasitas pengeluaran apa pun → 403 di `GET/POST/PATCH /expenses`. Mutasi lain
> tetap KASIR; `/reports/*` tetap OWNER-only.

| Role | Boleh | Ditolak |
|---|---|---|
| **KASIR** (operator) | Semua POST/PATCH/DELETE (master, pembelian, POS, void/refund, opname, cash session, retur distributor, payment-methods, profil toko) + semua GET kecuali daftar laporan | `GET /expenses`, `GET /expenses/{id}`, **`POST /expenses`, `PATCH /expenses/{id}`** (amandemen FE-11), seluruh `/reports/*` (403) |
| **OWNER** (monitor + opex) | Semua GET (termasuk laporan & daftar opex) **+ input/koreksi opex** | Semua mutasi lain (403), termasuk `POST /purchases`, `POST /sales`, `PATCH /store` |

### Error baru (backend v2)
| Code | HTTP | Kapan |
|---|---|---|
| `REFUND_QTY_EXCEEDED` | 422 | qty refund melebihi sisa item terjual |
| `REFUND_AMOUNT_EXCEEDED` | 422 | total refund > sisa uang yang dibayar (customer) atau > `total_cost` (distributor) |
| `VOID_ITEM_MISMATCH` | 422 | `sale_item_id` bukan item dari penjualan tsb / refund tanpa item yang bisa dikembalikan |
| `DAMAGED_QTY_INSUFFICIENT` | 409 | retur distributor atau koreksi opname melebihi `qty_damaged` batch |
| `SUPPLIER_RETURN_SETTLED` | 409 | settle ulang retur yang sudah REFUNDED/WRITTEN_OFF |
| `FORBIDDEN` | 403 | role tidak berwenang (RBAC v2) |

> PPN saat refund parsial **belum** dihitung proporsional (keputusan plan §8.3) — dicatat sebagai keterbatasan.


---

## 3. Peta Error DB → HTTP
| Pesan error DB | HTTP |
|---|---|
| `Stok tidak cukup batch ...` | `409 CONFLICT` |
| `Harga jual ... tidak boleh di bawah harga beli ...` | `422 UNPROCESSABLE` |
| `Total pembayaran ... melebihi total penjualan` | `422` |
| `reference_no wajib untuk metode ini` | `422` |
| `Metode pembayaran tidak aktif` | `422` |
| `Tidak dapat void penjualan yang sudah dibayar ...` | `409` |
| `sale_items tidak boleh dihapus; gunakan void` | `405` |

## 4. Referensi
- OpenAPI/Swagger: `openapi.yaml` (sejajar file ini, 41 path)
- Plan & tasklist backend v2: `plan-backend-v2-refund-rusak-opname-rbac.md`, `tasklist-backend-v2.md`
- DDL baseline: `inventory_pos_migration_v2.sql` (folder temp opencode) · migrasi lanjutan 0001–0007 di `src/db/migrate.ts`
- Uji: `npm run e2e` (UC A–D + matriks RBAC), `npm run concurrency` (2 POS), `npm run mark-test-data`
- Use case asal: kartu Telkomsel 20@40rb → jual 4@50rb (nego OK, < beli ditolak), opname harian, partial payment, bank transfer via menu.
- Use case v2: `test_usecase.md` UC-A s/d UC-D (refund parsial rusak, retur distributor, void berlabel, opname detail).
