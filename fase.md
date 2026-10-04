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
- [ ] Setup repo backend + koneksi DB dari `.env` (pool, timeout, SSL opsional)
- [ ] Migration manager (mis. golang-migrate / knex / prisma) — import `inventory_pos_migration_v2.sql` sebagai baseline
- [ ] Seed: minimal 2 `user_account` (owner, kasir1) + role sederhana (OWNER/KASIR)
- [ ] Isi data rekening `payment_methods` BANK_TRANSFER yang asli
- [ ] Auth: login JWT, middleware role
- **Done when:** login dapat token, pool connect, migration `up/down` jalan.

### FASE 1 — Master Data & Menu (2–3 hari)
- [ ] CRUD produk (barcode scan-friendly: cari by barcode/sku), kategori, tipe
- [ ] CRUD `payment_methods` (aktif/nonaktif, rekening bank) — inilah "set di menu"
- [ ] CRUD customer (opsional untuk walk-in)
- **Endpoints:** `GET/POST /products`, `GET/PATCH/DELETE /products/{id}`, sama untuk categories, payment-methods
- **Done when:** bisa tambah produk minimarket (kg/ml/pcs) & metode QRIS via menu.

### FASE 2 — Pembelian / Barang Masuk (2 hari)
- [ ] Form beli bulk → 1 `stock_batches` + movement IN otomatis (transaksi tunggal)
- [ ] Expired date opsional; harga beli per batch
- [ ] List batch + stok per batch (query langsung, tanpa view)
- **Endpoints:** `POST /purchases`, `GET /purchases`, `GET /stock?product_id=`
- **Done when:** beli 20 pcs kartu @40.000 exp 2026-10-11 → batch 20, ledger IN +20.

### FASE 3 — Penjualan POS / Barang Keluar (3–4 hari)
- [ ] Layar kasir: scan → keranjang → bayar (Fixed price = default `harga_jual`; nego diizinkan, < harga beli diblok DB)
- [ ] `POST /sales` atomic: header + items + payment pertama dalam 1 transaksi DB
- [ ] Idempotency-Key + `sale_no` dari sequence
- [ ] Mapping error DB → HTTP: stok kurang/harga di bawah beli = `409`
- **Done when:** jual 4 pcs @50.000 → stok 16, `payment_status` benar (PAID jika lunas, PARTIAL jika DP).

### FASE 4 — Pembayaran Partial & Multi Metode (2–3 hari)
- [ ] `POST /sales/{id}/payments` (DP/pelunasan, CASH dengan tendered→change, BANK_TRANSFER wajib `reference_no`)
- [ ] Daftar pembayaran per sale + sisa tagihan
- [ ] Cetak/struk sederhana (opsional fase ini)
- **Done when:** AT-2 s/d AT-4 & AT-8 dari acceptance DB lulus lewat API.

### FASE 5 — Void / Retur (2 hari)
- [ ] Void sale (alasan wajib, stok kembali via movement IN, ditolak jika sudah dibayar)
- [ ] Retur per item (status RETURNED) — sama-sama auditable
- **Done when:** AT-6, AT-7 lulus via API; tidak ada endpoint delete sale/item.

### FASE 6 — Stok Opname Harian (2 hari)
- [ ] Form opname: generate system_qty otomatis (query langsung), input physical_qty
- [ ] Simpan + movement ADJUSTMENT otomatis untuk selisih (rekomendasi: trigger/app insert movement ADJUSTMENT agar `qty_remaining` sinkron)
- [ ] Riwayat opname + rekap selisih
- **Endpoints:** `POST /opnames`, `GET /opnames?date=`
- **Done when:** opname harian tersimpan, selisih tercatat, stok terkoreksi.

### FASE 7 — Hardening Multi-POS (2–3 hari)
- [ ] Uji beban 2 terminal simulasi: concurrency 50 sales/detik ke batch sama → 0 oversell, 0 stok minus
- [ ] Idempotency-Key diverifikasi (retry tidak dobel transaksi)
- [ ] Audit log aplikasi (who/when) untuk semua mutasi
- [ ] Backup harian `pg_dump` + retensi; monitor koneksi pool
- **Done when:** skenario 2 POS bersamaan bersih tanpa inkonsistensi stok/kas.

### FASE 8 — Pengeluaran Operasional & Laba Bersih/Netto (SELESAI)
- [x] Tabel `operational_expenses` (migration 0002): category dinormalisasi, `amount > 0`, audit created/updated
- [x] `GET/POST /expenses`, `GET/PATCH /expenses/{id}` — **OWNER-only** (kasir 403)
- [x] `GET /reports/pnl?month=YYYY-MM` — OWNER-only: pendapatan, HPP, laba kotor, beban per kategori, **laba bersih = laba kotor − opex**, laba netto (= laba bersih; pajak belum dimodelkan), piutang berjalan. Basis akrual (sales COMPLETED periode, TZ Asia/Jakarta)
- **Done when:** owner input gaji/listrik/internet → P&L ter-update; kasir ditolak 403.

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
- OpenAPI/Swagger: `openapi.yaml` (sejajar file ini)
- DDL baseline: `inventory_pos_migration_v2.sql` (folder temp opencode)
- Use case asal: kartu Telkomsel 20@40rb → jual 4@50rb (nego OK, < beli ditolak), opname harian, partial payment, bank transfer via menu.
