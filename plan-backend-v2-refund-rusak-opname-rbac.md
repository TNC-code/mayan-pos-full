# Plan Backend v2 — Refund Parsial, Stok Rusak, Retur Distributor, Opname Detail, RBAC Baru

> **Status: DISETUJUI — siap eksekusi (mulai T1)**
> Lanjutan `fase.md` (backend API-only). Semua perubahan schema lewat migration **0005** (pola 0001–0004: `CREATE ... IF NOT EXISTS`, idempotent, forward-only).
> Prinsip tetap: **ledger immutable, stok hanya berubah via trigger `stock_movements`, tanpa VIEW.**

## Daftar Isi
1. [Alur Utama (big picture)](#1-alur-utama-big-picture)
2. [Use Case yang Dijawab](#2-use-case-yang-dijawab)
3. [RBAC Baru](#3-rbac-baru)
4. [Migration 0005 (DDL)](#4-migration-0005-ddl)
5. [Task Plan](#5-task-plan)
6. [Detail Teknis Wajib](#6-detail-teknis-wajib)
7. [Risiko & Mitigasi](#7-risiko--mitigasi)
8. [Decision Points (final)](#8-decision-points-final)

---

## 1. Alur Utama (big picture)

```
BARANG RUSAK (dari refund customer / void)
   │
   ▼
KEMBALI KE STOK + LABEL (RUSAK/VOID)      ← qty_damaged: karantina, TIDAK bisa dijual
   │
   ▼
KASIR BUAT TRANSAKSI RETUR DARI STOK RUSAK ← POST /supplier-returns (RTR-YYYYMMDD-NNN)
   │                                          movement OUT → qty_damaged berkurang
   ▼
SETTLE:
   ├─ distributor bayar  → REFUNDED  (uang masuk → muncul di P&L)
   └─ distributor tolak  → WRITTEN_OFF (otomatis jadi opex BARANG_RUSAK)
```

Dua langkah **terpisah dan teraudit** di ledger:
1. **Masuk rusak** — `stock_movements IN` dengan `condition='RUSAK'`, label `RETURN`/`VOID`.
2. **Transaksi retur** — `stock_movements OUT` dengan `reference_type='SUPPLIER_RETURN'`.

Guard utama: barang di `qty_damaged` **tidak akan pernah bisa ikut terjual POS** (validasi jual hanya membaca `qty_remaining`).

---

## 2. Use Case yang Dijawab

### UC-A — Refund parsial barang rusak (nota sudah DIBAYAR)
> Nota 11 kartu @24.500 sudah PAID. Customer balik 1 kartu rusak → uang 24.500 kembali, kartu rusak masuk karantina (bukan stok jual).

`POST /sales/{id}/refund` (revisi):
```jsonc
// Body + header Idempotency-Key (sudah ada)
{
  "reason": "kartu rusak",
  "method_id": 1,                              // optional; default = metode bayar terakhir
  "items": [                                    // optional; tanpa items = refund penuh (kompatibel FE lama)
    { "sale_item_id": 12, "qty": 1, "condition": "RUSAK" }   // GOOD | RUSAK
  ]
}
```
1. Validasi: `payment_status != UNPAID` (UNPAID → pakai void); `qty` ≤ qty jual − qty sudah direfund; total refund ≤ `paid_amount − refunded_amount`.
2. Insert `refunds` (uang kembali) + **`refund_items`** (detail per item).
3. Insert `stock_movements IN` per item: `GOOD` → `qty_remaining +` (label RETURN); `RUSAK` → `qty_damaged +`.
4. Status sale: **parsial → tetap COMPLETED** (hanya `refunded_amount` naik); **semua item habis direfund → RETURNED**.
5. P&L: otomatis benar — `PnlReport.total_refund` sudah membaca tabel `refunds`.

### UC-B — Retur ke distributor → gagal? jadi opex
Endpoint baru:
| Endpoint | Fungsi |
|---|---|
| `GET /stock/damaged` | Daftar stok rusak per batch, siap diretur |
| `POST /supplier-returns` | `{supplier_name, items:[{batch_id, qty, unit_cost?}]}` → movement OUT (SUPPLIER_RETURN, RUSAK) → `qty_damaged −`; status `PENDING` |
| `GET /supplier-returns` · `GET /supplier-returns/{id}` | Riwayat + detail |
| `POST /supplier-returns/{id}/settle` | `{result:'REFUNDED', amount, method_id?, reference_no?}` **atau** `{result:'WRITTEN_OFF'}` |

Settle `WRITTEN_OFF` → **auto-insert `operational_expenses`**: category `BARANG_RUSAK`, `source='SUPPLIER_RETURN'`, link `supplier_return_id`, amount = Σ(qty × unit_cost).

P&L: baris baru `refund_distributor` (pendapatan lain) dari supplier_returns status REFUNDED di bulan berjalan.

### UC-C — Void berlabel (stok balik dengan kondisi)
`POST /sales/{id}/void` menerima optional `items:[{sale_item_id, condition}]`:
- Tanpa `items` → semua `GOOD` (perilaku lama, kompatibel).
- `condition:'RUSAK'` → masuk `qty_damaged`, movement label RUSAK.

### UC-D — Opname detail + laporan analisa
- `POST /opnames` — item: `{product_id, batch_id?, physical_qty, physical_qty_damaged?, cause?}`; `cause` ∈ `RUSAK|HILANG|SALAH_HITUNG|LAIN`.
- Selisih good → ADJUSTMENT good; selisih damaged → ADJUSTMENT RUSAK.
- `GET /opnames/{id}` → per item: `unit_cost`, **`value_difference` (Rp)**, `cause`, split good/damaged; header: total rugi/lebih Rp.
- `GET /reports/opname?month=YYYY-MM` (OWNER) → rekap: total selisih qty & Rp, per kategori, per cause, top 10 produk selisih, tren 6 bulan, stok rusak belum diretur.

---

## 3. RBAC Baru

Model: **KASIR = operator (semua input data) · OWNER = monitor (lihat laporan saja).**

| Grup endpoint | Sekarang | Menjadi |
|---|---|---|
| Mutasi master (products, categories, product-types, customers) | semua role | **KASIR** |
| `POST /purchases` (barang masuk + harga beli), PATCH harga jual | semua role | **KASIR** |
| `POST /sales`, payments, void, refund | semua role | **KASIR** |
| `POST /opnames`, `POST /supplier-returns` (+settle) | semua role / belum ada | **KASIR** |
| `POST/PATCH /expenses` | OWNER | **KASIR** (input) |
| `POST/PATCH /payment-methods`, `PATCH /store` | OWNER | **KASIR** |
| `GET /expenses`, `GET /reports/pnl`, `/reports/dashboard`, `/reports/opname` (baru) | OWNER | **OWNER** (tetap) |
| `GET /sales`, `/stock`, `/opnames`, `/cash-sessions`, `/alerts`, ledger | semua role | semua role |

> Catatan: kasir memang sudah bisa input master/purchases sejak awal — perubahan nyata: **OWNER di-block dari semua mutasi** + input opex/payment-methods pindah ke kasir.

---

## 4. Migration 0005 (DDL)

```sql
-- 1) Stok rusak (karantina, tidak dijual)
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS qty_damaged numeric(14,3) NOT NULL DEFAULT 0;
-- + CHECK (qty_damaged >= 0)

-- 2) Ledger: kondisi per movement (baris lama default GOOD)
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS condition varchar(10) NOT NULL DEFAULT 'GOOD';

-- 3) Refund parsial
CREATE TABLE IF NOT EXISTS refund_items (
  id           bigserial PRIMARY KEY,
  refund_id    bigint NOT NULL REFERENCES refunds(id),
  sale_item_id bigint NOT NULL REFERENCES sale_items(id),
  qty          numeric(14,3) NOT NULL CHECK (qty > 0),
  condition    varchar(10) NOT NULL DEFAULT 'GOOD',
  unit_price   numeric(14,2) NOT NULL,   -- snapshot harga jual saat transaksi
  subtotal     numeric(14,2) NOT NULL
);

-- 4) Retur distributor
CREATE SEQUENCE IF NOT EXISTS supplier_return_no_seq AS bigint;
CREATE TABLE IF NOT EXISTS supplier_returns (
  id                  bigserial PRIMARY KEY,
  return_no           text NOT NULL UNIQUE,          -- RTR-YYYYMMDD-NNN
  supplier_name       text NOT NULL,
  status              varchar(12) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','REFUNDED','WRITTEN_OFF')),
  total_cost          numeric(14,2) NOT NULL DEFAULT 0,
  refunded_amount     numeric(14,2),
  refunded_method_id  integer REFERENCES payment_methods(id),
  refunded_at         timestamptz,
  settled_by          integer REFERENCES user_account(id),
  note                text,
  created_by          integer REFERENCES user_account(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS supplier_return_items (
  id         bigserial PRIMARY KEY,
  return_id  bigint NOT NULL REFERENCES supplier_returns(id),
  product_id integer NOT NULL REFERENCES product(id),
  batch_id   bigint REFERENCES stock_batches(id),
  qty        numeric(14,3) NOT NULL CHECK (qty > 0),
  unit_cost  numeric(14,2) NOT NULL,
  condition  varchar(10) NOT NULL DEFAULT 'RUSAK'
);

-- 5) Opex jejak otomatis
ALTER TABLE operational_expenses ADD COLUMN IF NOT EXISTS source varchar(12) NOT NULL DEFAULT 'MANUAL';
ALTER TABLE operational_expenses ADD COLUMN IF NOT EXISTS supplier_return_id bigint REFERENCES supplier_returns(id);

-- 6) Opname detail
ALTER TABLE stock_opname_items ADD COLUMN IF NOT EXISTS physical_qty_damaged numeric(14,3);
ALTER TABLE stock_opname_items ADD COLUMN IF NOT EXISTS cause varchar(12);
```

**Revisi trigger** (`CREATE OR REPLACE`, pola 0003):
| Trigger | Perubahan |
|---|---|
| `fn_stock_movement_apply` | IN + RUSAK → `qty_damaged +` (bukan `qty_remaining`); OUT `SUPPLIER_RETURN` + RUSAK → `qty_damaged −`; guard `qty_damaged >= 0` |
| `fn_sales_void_apply` | Auto-restock untuk **RETURNED dimatikan** (restock dilakukan service refund per-item bercondition); VOIDED tetap auto-restock (default GOOD) |
| `fn_sale_item_validate` dll. | **Tidak disentuh** — aturan jual tetap |

---

## 5. Task Plan

| # | Task | File utama | Acceptance | Est |
|---|---|---|---|---|
| T1 | Migration 0005 + revisi trigger | `src/db/migrate.ts` | `npm run migrate` idempotent; kolom/tabel/trigger baru ada; data lama tak berubah | 0.5h |
| T2 | Refund parsial + void berlabel | `sale.service.ts`, `sale.controller.ts`, `schemas.ts` | UC-A & UC-C via API; `refunds`+`refund_items` benar; movement IN RUSAK; `qty_damaged` benar; parsial=COMPLETED, penuh=RETURNED | 1d |
| T3 | Retur distributor + write-off | `supplier-return.service.ts` (baru), `docno.ts`, `expense.service.ts` | UC-B: create → `qty_damaged −`; settle REFUNDED & WRITTEN_OFF (auto-opex ber-link) benar | 1d |
| T4 | Opname detail + laporan analisa | `opname.service.ts`, `report.service.ts`, `stock.service.ts` | UC-D: `value_difference` & `cause` tampil; `/reports/opname` benar; `/stock` & `/stock/damaged` tampil rusak | 1d |
| T5 | RBAC matrix baru | `routes/index.ts` | KASIR 403 di `/reports/*` + `GET /expenses`; OWNER 403 di semua mutasi | 0.5d |
| T6 | P&L `refund_distributor` | `report.service.ts` | REFUNDED bulan M tampil di `/reports/pnl?month=M` | 0.25d |
| T7 | OpenAPI + docs | `openapi.yaml`, `fase.md`, `test_usecase.md` | Path sinkron kode (36 → ±42); UC A–D terdokumentasi | 0.5d |
| T8 | E2E + regresi | `scripts/e2e.sh`, `scripts/concurrency.ts` | Skenario A–D masuk e2e; 2 POS tetap 0 oversell; tidak ada regres | 0.5–1d |

**Total: ±5–6 hari kerja.** Urutan dependensi: T1 → T2 → T3 → T4; T5–T8 setelahnya (T5/T6/T7 bisa paralel).

---

## 6. Detail Teknis Wajib

1. **Uang refund per item** = `qty × unit_price` (snapshot `sale_items`, harga nego saat jual). PPN proporsional belum dihitung (lihat §8.3).
2. **Nomor retur distributor** = sequence `supplier_return_no_seq` via `docno.ts`, format `RTR-YYYYMMDD-NNN`.
3. **Restock rule tunggal**: GOOD → `qty_remaining`; RUSAK → `qty_damaged`. Satu-satunya jalur menambah `qty_damaged` = movement IN/ADJUSTMENT bercondition RUSAK.
4. **Batch selection** untuk supplier-return: validasi `qty ≤ qty_damaged` batch tsb dengan `FOR UPDATE`.
5. **Idempotency-Key**: tetap wajib di `POST /sales/{id}/refund`; **baru** di `POST /supplier-returns` dan `settle`.
6. **Error baru**: `REFUND_QTY_EXCEEDED` (422) · `DAMAGED_QTY_INSUFFICIENT` (409) · `SUPPLIER_RETURN_SETTLED` (409) · `VOID_ITEM_MISMATCH` (422).
7. **Backward compatible**: refund/void tanpa `items` = perilaku lama (full, semua GOOD) — FE rencana tidak pecah.

---

## 7. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| Revisi `fn_sales_void_apply` menyentuh data berjalan (paling berisiko) | T1–T2 dikerjakan berdampingan; uji ulang skenario void/refund lama di e2e sebelum lanjut T3 |
| Double-counting stok rusak (trigger vs service) | Satu penulis movement saja (direkomendasikan: **service**; trigger hanya guard) |
| Beban input opname naik (good + damaged) | `physical_qty_damaged` opsional — default = system damaged, tanpa adjustment |

---

## 8. Decision Points (final — disetujui)

| # | Keputusan | Nilai final |
|---|---|---|
| 1 | OWNER read-only total (termasuk payment-methods & store profile) | **Ya** — semua mutasi = KASIR |
| 2 | KASIR boleh `POST /expenses` tapi tidak boleh `GET /expenses` | **Ya** |
| 3 | PPN ikut refund parsial? | **Belum** — dicatat sebagai note |
| 4 | Struk retur customer/distributor (print) | **Fase FE** — bukan backend ini |
