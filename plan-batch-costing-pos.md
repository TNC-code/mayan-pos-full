# Plan — Batch Costing di POS: Pilih Batch + Harga Jual dari Markup + Nego ≥ Harga Beli

> **Status: ✅ SELESAI** (backend + FE + e2e 33 PASS; flutter test 560 PASS, analyze bersih) · Sumber: `baruplan.md` (use case MCT/MKN + 7 poin requirement)
> Ruang lingkup: BE (migration 0010 + API) · FE Flutter (form barang masuk + modal detail item keranjang) · e2e laba rugi

> Keputusan user (2026-10-08): kasir **boleh melihat harga beli** di fase ini; harga jual
> produk auto-sync dari batch terbaru; jual di bawah harga beli diblok total (tanpa
> override OWNER); tombol `SAMAKAN` = bagi rata kolom Ambil.

---

## 9. Hasil Implementasi (2026-10-08)

| Area | File | Status |
|---|---|---|
| BE | `src/db/migrate.ts` — 0010: `markup_type`/`markup_value`/`suggested_price` (generated) + constraint + trigger sync `harga_jual` | ✅ |
| BE | `src/controllers/schemas.ts` — `purchaseSchema` markup wajib; `productBatchListSchema` | ✅ |
| BE | `src/services/purchase.service.ts` — simpan markup; BatchRow += 3 kolom; `listProductBatches()` | ✅ |
| BE | `src/controllers/stock.controller.ts` + `src/routes/index.ts` — `GET /products/:id/batches` | ✅ |
| BE | `openapi.yaml` — StockBatch/PurchaseInput markup + endpoint picker | ✅ |
| E2E | `scripts/e2e_batch_nego.ts` (`npm run e2e:batch`) — 33 PASS: sync harga, picker FIFO, jual per batch, nego 422, split 2 batch 1 harga nego, void balik stok, HPP per batch (66.500 → HPP 56.600 → laba 9.900), opname nilai per batch | ✅ |
| FE | `lib/models/purchase.dart` — PurchaseInput markup + `suggestedPrice`; StockBatch markup fields | ✅ |
| FE | `lib/api/purchase_api.dart` — `listProductBatches()` | ✅ |
| FE | `lib/models/cart_item.dart` — `BatchAllocation` + JSON draft + floor `minUnitPrice` + usulan tertimbang | ✅ |
| FE | `lib/models/sale.dart` — `SaleItemInput.listFromCartItem` (pecah per batch, ALT → per satuan dasar) | ✅ |
| FE | `lib/providers/cart.dart` — `setAllocations` + guard (Σ ambil, stok per batch, floor batch termahal); setQty/setUnit sadar alokasi | ✅ |
| FE | `lib/features/purchases/purchase_form_dialog.dart` — toggle `Rp/pcs | %` + preview `beli + markup = jual` | ✅ |
| FE | `lib/features/pos/cart_item_details_sheet.dart` (BARU) — modal Detail Item per mockup: qty, tabel batch (✓ + Stok + Ambil), Harga Nego + RESET/SAMAKAN, Batal/Update | ✅ |
| FE | `lib/features/pos/cart_panel.dart` + `cart_line_tile.dart` — hook modal + badge `N batch` | ✅ |
| FE | test: `cart_test.dart` (+9 test alokasi & payload), `pos_screen_test.dart` (flow modal baru), `stock_models_test.dart` (markup), fake API picker | ✅ |
| Fix | `fe/test/models/order_book_models_test.dart` — ekspektasi tanggal hardcoded → dihitung dari `resolvedFrom()` (date-flaky sejak 8 Okt) | ✅ |

---

## 0. Use Case (dari baruplan.md)

Order ke vendor berbeda untuk produk yang sama, harga beli berbeda per batch:

| Batch | Tanggal | Vendor | Produk | Harga beli | Qty |
|---|---|---|---|---|---|
| 1 | 11 Jan 2026 | MCT | SP TSEL 10GB | 7.000/pcs | 200 |
| 1 | 11 Jan 2026 | MCT | VC TSEL 20GB | 10.000/pcs | 200 |
| 2 | 20 Jan 2026 | MKN | SP TSEL 10GB | 7.200/pcs (+200) | 100 |
| 2 | 20 Jan 2026 | MKN | VC TSEL 20GB | 9.500/pcs (−500) | 22 |

7 requirement:
1. POS bisa **pilih batch** per item walau produk sama (harga beli & sisa qty beda per batch)
2. UI/UX mengikuti mockup "Cart Item Details" (tabel batch: checkbox + Stok + **Ambil**, field **Harga Nego**)
3. Input stok **wajib** ada harga beli + harga jual — harga jual auto dari markup (**% atau Rp/pcs**)
4. Contoh: beli 12.500 → set margin 1.000 → tampil harga jual **13.500**
5. Kasir boleh **nego** (mis. jual 12.300)
6. Harga jual tidak terikat, **asal tidak boleh di bawah harga beli**
7. Flow benar end-to-end sampai **stok opname** + laba rugi konsisten

---

## 1. Yang SUDAH Ada (tidak dibangun ulang)

| Capability | Lokasi | Catatan |
|---|---|---|
| Batch + harga beli | `stock_batches` (unit_cost, qty_remaining) | Sudah per batch sejak baseline |
| POS pilih batch eksplisit | `POST /sales` item `batch_id` → `resolveBatchId()` (`sale.service.ts:295`) | Auto-FIFO bila kosong |
| **Floor harga nego** | Trigger `fn_sale_item_validate`: `unit_price < batch.unit_cost` → REJECT | Req #6 sudah dijaga DB |
| Laba rugi konsisten | HPP = `SUM(sale_items.unit_cost × qty)` (`report.service.ts:65`) | `unit_cost` di-snapshot trigger dari batch terpilih → harga beli naik/turun antar batch TIDAK merusak P&L |
| Opname per batch | `POST /opnames` item `batch_id` (`opname.service.ts`) | Nilai selisih pakai unit_cost batch |
| Sync harga beli produk | Trigger `fn_batch_update_product_cost` | `product.harga_beli` ← batch terbaru |
| FE payload batch | `SaleItemInput.batchId` (`sale.dart:570`) | Sudah ada, **belum pernah diisi** dari cart |

## 2. GAP yang Dibangun

| # | Gap | Solusi |
|---|---|---|
| G1 | Batch tidak punya harga jual (markup); `product.harga_jual` tidak pernah di-sync dari input stok | **Migration 0010**: `markup_type` + `markup_value` + generated `suggested_price`; extend trigger sync `harga_jual` |
| G2 | `POST /purchases` tidak terima markup | Schema + service + response baru |
| G3 | Tidak ada API picker batch untuk layar kasir | `GET /products/{id}/batches` |
| G4 | FE form barang masuk tidak ada input harga jual | Markup Rp/% + preview `harga beli + markup = harga jual` |
| G5 | FE POS tidak ada modal detail item (pilih batch + harga nego) | Modal "Detail Item" sesuai mockup; cart line dipecah per batch saat checkout |
| G6 | Guard nego FE masih pakai harga beli produk (bukan batch terpilih) | min price = `max(unit_cost)` batch terpilih |
| G7 | Belum ada bukti e2e Req #7 | Script e2e skenario baruplan (batch 1 & 2 → jual per batch → nego → opname → P&L) |

---

## 3. Desain Data — Migration 0010 `batch_markup_suggested_price`

```sql
-- 1) Markup per batch (sumber harga jual usulan)
ALTER TABLE public.stock_batches
  ADD COLUMN IF NOT EXISTS markup_type  varchar(10),          -- NULL = batch lama (belum pernah set markup)
  ADD COLUMN IF NOT EXISTS markup_value numeric(14,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_batch_markup_type') THEN
    ALTER TABLE public.stock_batches
      ADD CONSTRAINT chk_batch_markup_type
      CHECK (markup_type IS NULL OR markup_type IN ('AMOUNT','PERCENT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_batch_markup_value') THEN
    ALTER TABLE public.stock_batches
      ADD CONSTRAINT chk_batch_markup_value CHECK (markup_value >= 0);
  END IF;
END $$;

-- 2) Harga jual usulan dari batch ini (generated, selalu ada):
--    AMOUNT : harga beli + Rp/pcs   (contoh req #4: 12500 + 1000 = 13500)
--    PERCENT: harga beli × (1 + %)  (contoh: 12500 + 10% = 13750)
--    NULL   : fallback harga beli (batch lama tidak berubah)
ALTER TABLE public.stock_batches
  ADD COLUMN IF NOT EXISTS suggested_price numeric(14,2)
  GENERATED ALWAYS AS (
    CASE markup_type
      WHEN 'AMOUNT'  THEN round(unit_cost + markup_value, 2)
      WHEN 'PERCENT' THEN round(unit_cost * (1 + markup_value / 100.0), 2)
      ELSE unit_cost
    END
  ) STORED;

-- 3) Trigger sync diperluas: batch BARU juga menyelaraskan harga jual produk
--    (pola sama dengan harga_beli yang sudah ada sejak baseline).
CREATE OR REPLACE FUNCTION public.fn_batch_update_product_cost() ... 
    UPDATE product SET harga_beli = NEW.unit_cost,
                       harga_jual = COALESCE(NEW.suggested_price, harga_jual),
                       updated_at = now() WHERE id = NEW.product_id;
```

Keputusan desain:
- **Harga jual tersimpan di produk** (default tampilan POS), **harga beli tetap di batch** (floor nego).
  Nego kasir tidak mengubah keduanya — hanya `sale_items.unit_price` yang snapshot.
- Batch lama (`markup_type IS NULL`) → `suggested_price = unit_cost`; `harga_jual` produk TIDAK ditimpa
  (trigger hanya berjalan untuk batch baru) → data produksi aman.
- Markup **wajib** di API (`POST /purchases`): `markup_type` enum + `markup_value >= 0` — memenuhi req #3
  "harus ada harga beli, harga jual". `markup_value: 0` sah (jual netral).

## 4. Desain API

### 4.1 `POST /purchases` (ubah — G2)
```jsonc
{
  "product_id": 1, "qty": 200, "unit_cost": 12500,
  "markup_type": "AMOUNT",     // BARU: 'AMOUNT' | 'PERCENT' (wajib)
  "markup_value": 1000,        // BARU: Rp/pcs atau % (wajib, >= 0)
  "supplier": "MCT", "expired_date": "2026-01-11", "notes": "batch 1"
}
// 201 → { ..., "suggested_price": 13500 }   // konfirmasi harga jual di form
```
`BatchRow` += `markup_type`, `markup_value`, `suggested_price` → otomatis ikut di
`GET /purchases`, `GET /purchases/batches/{id}`.

### 4.2 `GET /products/{id}/batches?available_only=true` (baru — G3)
Picker layar kasir. Semua role (login wajib). Urut FIFO (`expired_date NULLS LAST, id ASC`).
```jsonc
{ "data": [ { "id": 3, "batch_code": "GRN-20260111-001", "qty_remaining": 178,
              "unit_cost": 12500, "suggested_price": 13500,
              "expired_date": null, "supplier": "MCT", "received_at": "..." } ] }
```

### 4.3 `POST /sales` (TIDAK berubah)
Item `batch_id` eksplisit + `unit_price` nego. Satu produk dari 2 batch = **2 baris
`sale_items`** dengan `unit_price` sama (trigger validasi floor per baris). FE yang
memecah baris keranjang ber-alokasi batch.

## 5. Desain FE Flutter

### 5.1 Form Barang Masuk (`purchase_form_dialog.dart` — G4)
- Segmented toggle markup: **`Rp / pcs`** | **`%`** + input `markup_value` (wajib, default mengikuti
  `harga_jual − harga_beli` produk bila keduanya > 0)
- Preview live: `Harga beli 12.500 + 1.000 = Harga jual 13.500` (req #4)
- `PurchaseInput` += `markupType`, `markupValue` (`models/purchase.dart`, validate: >= 0)

### 5.2 Modal "Detail Item Keranjang" (baru, `features/pos/cart_item_details_sheet.dart` — G5)
Meniru mockup WhatsApp:
```
┌ Detail Item ──────────────────────────────── ✕ ┐
│ SP TSEL 10GB   Rp 13.500 × 150   subtotal Rp 2.025.000 │
│ Jumlah item   [−] 150 [+]                              │
│ ┌─┬ Batch            ┬ Stok ┬ Ambil ┐                   │
│ │✓│ GRN-...-001 (MCT)│ 200  │ 150   │  ← unit_cost 12.500, usul 13.500 │
│ │✓│ GRN-...-002 (MKN)│ 100  │  0    │  ← unit_cost 7.200, usul 7.400   │
│ └─┴───────────────────┴──────┴───────┘                   │
│ Harga nego  [ Rp 12.300 ]   [RESET] [SAMAKAN]           │
│ ⚠ minimal Rp 12.500 (harga beli batch termahal terpilih)│
│                          [ Batal ]  [ Update ]          │
└──────────────────────────────────────────────────────────┘
```
Aturan modal:
- Checkbox pilih batch, kolom **Ambil** = qty diambil per batch; `Σ ambil == qty item`
  (Update ditolak bila tidak pas — pesan Bahasa Indonesia)
- **Harga nego** satu nilai untuk semua pecahan; guard FE `nego >= max(unit_cost terpilih)`
  (req #5-6; server tetap penjaga akhir via trigger)
- `RESET` = kembali ke `suggested_price` batch; `SAMAKAN` = samakan semua kolom Ambil
  (sesuai label mockup: samakan alokasi tiap batch terpilih)
- Simpan ke `CartItem.batchAllocations: [{batchId, batchCode, qty, unitCost, suggestedPrice}]`
- Tanpa alokasi (modal tidak dibuka / semua kosong) → perilaku lama auto-FIFO server

### 5.3 Cart & Checkout (G5/G6)
- `cart_line_tile.dart`: badge `2 batch` + tombol edit membuka modal detail (bukan hanya nego)
- `cart.dart`: `setAllocations(lineId, allocations, unitPrice)`; guard stok per batch
  (ambil ≤ `qty_remaining` batch); `minUnitPrice` line ber-alokasi = `max(unitCost)`
- `checkout`: `SaleItemInput.fromCartItem` memecah 1 line → N input `{batch_id, qty, unit_price}`
  dengan `unit_price` nego yang sama
- Harga default saat tambah ke cart: `product.harga_jual` (kini ter-sync dari batch terbaru)

## 6. E2E — Bukti Req #7 (laba rugi & opname konsisten)

`scripts/e2e_batch_nego.ts` (dipanggil `npm run e2e:batch`):
1. Buat produk `E2E SP TSEL 10GB`
2. **Batch 1** (supplier MCT): 200 × 7.000, markup AMOUNT 3.000 → `suggested_price` 10.000,
   `product.harga_jual` ter-sync = 10.000
3. **Batch 2** (supplier MKN): 100 × 7.200, markup PERCENT 10% → `suggested_price` 7.920,
   `product.harga_jual` ter-sync = 7.920 (batch terbaru menang)
4. POS jual 5 pcs **dari batch 2** @ nego 7.500 → sukses; `sale_items.unit_cost = 7.200`
5. POS coba jual @ 7.000 dari batch 2 → **422** (`Harga jual (7000) tidak boleh di bawah harga beli (7200)`)
6. POS jual 3 pcs **dari batch 1** @ 10.000 → `unit_cost = 7.000`
7. Void 1 baris → stok batch kembali persis (qty_remaining balik)
8. Opname per batch → selisih & nilai selisih pakai unit_cost batch masing-masing
9. P&L bulan berjalan: HPP = Σ (qty × unit_cost batch terpilih) — bukan rata-rata,
   bukan harga beli produk → **laba rugi konsisten walau harga vendor naik/turun**

## 7. Daftar Perubahan File

| Area | File | Perubahan |
|---|---|---|
| BE | `src/db/migrate.ts` | Migration 0010 (kolom + constraint + generated + trigger) |
| BE | `src/controllers/schemas.ts` | `purchaseSchema` += markup (wajib); query schema picker |
| BE | `src/services/purchase.service.ts` | simpan markup; BatchRow += 3 kolom |
| BE | `src/services/master.service.ts` (atau stock.service) | `listProductBatches(productId)` |
| BE | `src/controllers/master.controller.ts`, `src/routes/index.ts` | `GET /products/:id/batches` |
| BE | `openapi.yaml` | /purchases, /products/{id}/batches, contoh |
| FE | `lib/models/purchase.dart` | PurchaseInput += markupType/markupValue; StockBatch += suggested_price |
| FE | `lib/models/cart_item.dart` | BatchAllocation + serialisasi draft |
| FE | `lib/models/sale.dart` | fromCartItem → pecah per alokasi |
| FE | `lib/providers/cart.dart` | setAllocations + guard per batch |
| FE | `lib/providers/purchases.dart`, `lib/api/purchase_api.dart` | kirim markup; API picker batch |
| FE | `lib/features/purchases/purchase_form_dialog.dart` | input markup + preview harga jual |
| FE | `lib/features/pos/cart_item_details_sheet.dart` (baru) | modal batch + nego (mockup) |
| FE | `lib/features/pos/cart_line_tile.dart`, `cart_panel.dart` | badge batch + hook modal |
| Test | `scripts/e2e_batch_nego.ts`, `package.json` | skenario Req #7 |
| FE | `fe/test/...` | unit test model + widget modal |

## 8. Urutan Kerja

1. **BE**: migration 0010 → service/schema/route → `npm run migrate` + typecheck
2. **BE**: openapi.yaml
3. **E2E script** → jalankan → bukti flow 1–9
4. **FE model/provider** → **form barang masuk** → **modal detail item** → unit test + `flutter analyze`

---

## 10. Amandemen A — Edit Barang Masuk + Top-up Batch (2026-10-08)

> Permintaan: "kalau ada kesalahan input qty bisa diupdate?" → fitur koreksi + top-up,
> dengan **note detail** (komentar kode, openapi, plan ini) dan openapi di-update.

### 10.1 Migration 0011 `batch_update_trigger_and_edit`
Trigger `fn_batch_update_product_cost` diperluas:
- Firing: `AFTER INSERT OR UPDATE OF unit_cost, markup_type, markup_value` — perubahan kolom
  stok (qty_remaining, ribuan kali sehari) TIDAK memicu sync harga sia-sia.
- **Guard batch-terbaru**: sinkronisasi harga produk hanya bila batch yang ditulis adalah
  batch TERBARU produknya (`ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1`).
  Alasan: mengedit batch LAMA (perbaikan salah ketik) tidak boleh "meng mundurkan"
  `harga_beli`/`harga_jual` produk yang sudah merepresentasikan batch terbaru.

### 10.2 `PATCH /purchases/batches/{id}` — koreksi salah input (KASIR)
| Aturan | Implementasi |
|---|---|
| Batch belum boleh terpakai | Guard: tidak ada `sale_items` / `stock_opname_items` / `supplier_return_items` / movement non-IN (kecuali `ADJUSTMENT` ber-`reference_type='BATCH_EDIT'` = jejak koreksi sebelumnya). Langgar → **409** + pesan arahan Opname/Retur |
| Perubahan qty berjejak | Movement `ADJUSTMENT` (+/−) note "Koreksi salah input barang masuk: qty X -> Y" — ledger tetap utuh, qty_remaining berubah via trigger |
| Urutan tulis demi constraint `chk_batch_remaining_le_received` | qty NAIK → UPDATE `qty_received` dulu baru movement; qty TURUN → movement dulu baru UPDATE (menghindari pelanggaran kondisi sementara `qty_remaining <= qty_received`) |
| `batch_code` & `product_id` | Terkunci (tidak bisa pindah produk) |
| Edit harga batch terbaru | `harga_beli`/`harga_jual` produk ter-sync (trigger 0011); batch lama tidak menimpa |
| Zod | `batchUpdateSchema`: semua opsional, minimal satu (`refine`); `qty > 0` |

### 10.3 `POST /purchases` + `merge_into_batch_id` — top-up barang susulan
- Tidak membuat batch baru: `qty_received` dijumlah, movement `IN` baru ke batch tujuan
  (audit per-event tetap utuh), pricing mengikuti batch tujuan (markup input diabaikan).
- Syarat (server): produk sama (422) + `unit_cost` IDENTIK (422, pesan "wajib dibuat
  batch baru") — harga berbeda = batch baru agar harga beli per batch tetap murni.
- Urutan tulis: UPDATE `qty_received` dulu → movement IN (alasan constraint sama dengan 10.2).

### 10.4 FE Flutter
- `models/purchase.dart`: `PurchaseInput.mergeIntoBatchId` (toJson `?null-aware`) +
  `BatchUpdateInput` (patch parsial, `isEmpty`).
- `api/purchase_api.dart`: `updateBatch(id, input)`; `providers/purchases.dart`:
  `batchUpdateProvider` (invalidate riwayat/stok/ledger/alerts/katalog POS).
- Form barang masuk: dropdown **"Simpan ke"** (Batch baru / batch aktif produk); mode
  top-up mengunci harga beli + markup (badge "harga wajib sama"), kirim `merge_into_batch_id`.
- Dialog detail batch (Riwayat): tombol **Ubah** → `BatchEditDialog` — koreksi qty/harga/
  markup/expired/supplier/catatan, hanya field berubah yang dikirim; error 409/422 tampil
  inline (pesan server memandu ke Opname/Retur).

### 10.5 Verifikasi
- `scripts/e2e_batch_edit_topup.ts` — **32 PASS**: top-up sukses & guard-nya, koreksi qty
  (ADJUSTMENT tercatat), sync harga batch terbaru, guard batch terpakai (409), edit batch
  lama tidak menimpa harga produk.
- `scripts/e2e_batch_nego.ts` tetap **33 PASS** setelah trigger 0011 (regresi aman).
- FE: `flutter analyze` bersih; **568 test PASS**; uji manual tablet: top-up via form
  (GRN-009 100→120 qty_received) dan koreksi via detail batch (GRN-040 50→45, ledger
  `ADJUSTMENT -5`), guard 409 terbukti di batch yang sudah terjual.

### 10.6 Catatan deploy
- **Backend produksi (invcash.quotaku.com) harus di-deploy** agar fitur aktif di app
  tablet yang memakai API produksi — app uji tablet memakai
  `--dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1` (backend lokal).
