# Frontend Implementation Plan — POS Inventory

> ⚠️ **TERGANTIKAN (sebagian)** — Tech stack React di dokumen ini sudah tidak dipakai.
> FE sekarang: **Flutter tablet** → lihat `fe/plan-fe-flutter-tablet.md` (termasuk RBAC final v2: kasir=operator, owner=laporan saja).
> Bagian yang TETAP relevan di sini sebagai referensi: §2 (aturan API client/idempotency), §4b (konsep ledger), §5 (layout struk), §7 (ke concerns multi-POS).

> Backend: API only (36 paths, OpenAPI 3.0 — `openapi.yaml`, Swagger UI `/api-docs`)
> Target: aplikasi kasir + panel owner, **2 terminal POS / multi-user**, receipt printing
> Dokumen ini = rencana implementasi FE; tidak ada logic bisnis di FE (semua dijaga DB via trigger).

---

## 1. Tech Stack (rekomendasi MVP)

| Layer | Pilihan | Alasan |
|---|---|---|
| Framework | **Vite + React 18 + TypeScript** | cepat, TS cocok dengan zod-like validation, ekosistem besar |
| Data fetching | **TanStack Query (React Query) v5** | cache, retry, invalidation pasca-mutasi |
| Routing | React Router v6 | standar |
| State ringan | Zustand (auth/session/cart) | cart POS butuh reaktivitas sederhana |
| UI | Tailwind CSS + shadcn/ui | cepat rakit form & tabel |
| HTTP | fetch wrapper custom (axios optional) | butuh interceptor refresh + idempotency |
| Print | CSS `@media print` + window.print (thermal 58/80mm) | tanpa dependency berat |
| Validasi | zod | mirror schema API |

Struktur folder:
```
src/
  api/          # client.ts (interceptor), endpoints per modul, types dari openapi
  stores/       # auth.ts, cart.ts, cashSession.ts
  components/   # ui/ (shadcn), layout/, receipt/
  features/
    auth/ login/
    pos/        # layar kasir (utama)
    sales/      # riwayat, detail, pembayaran, void/refund
    stock/      # stok, ledger, alerts
    purchases/  # barang masuk
    opname/
    cash-session/
    owner/      # dashboard, pnl, expenses, payment-methods, store, master products
  lib/          # idempotency.ts, money.ts, receipt-format.ts
```

---

## 2. API Client — ATURAN WAJIB (dari desain backend)

### 2.1 Base & Auth
- Base URL: `VITE_API_URL` (default `http://localhost:3000/api/v1`)
- Semua request (kecuali login/refresh) wajib `Authorization: Bearer <token>`
- JWT umur **12 jam**; refresh_token **7 hari**

### 2.2 Auto-refresh (interceptor)
```
401 (token expired)
  -> POST /auth/refresh { refresh_token }
  -> sukses: simpan token baru, ULANGI request asli (sekali saja)
  -> gagal  : bersihkan session -> redirect /login
```
- Simpan: token + refresh_token di localStorage (atau memory + refresh di localStorage)
- Logout button → `POST /auth/logout` (cabut refresh) → clear local

### 2.3 Idempotency-Key (WAJIB, uuid v4 per submit)
Endpoint yang **harus** kirim header `Idempotency-Key`:
- `POST /sales`
- `POST /sales/{id}/payments`
- `POST /sales/{id}/refund`

Aturan FE: generate UUID **saat user buka form/klik bayar pertama kali**, simpan di state; retry (network fail) pakai key SAMA. Response replay punya header `Idempotency-Replayed: true` → tampilkan info "transaksi sudah tercatat sebelumnya".

### 2.4 Peta Error → UX
| HTTP / code | Arti | UX |
|---|---|---|
| 409 `INSUFFICIENT_STOCK` | stok kurang | toast merah "Stok tidak cukup: tersedia X" → update cart |
| 422 `PRICE_BELOW_COST` | harga nego < harga beli | blok tombol di FE (validasi client) + toast |
| 422 `PAYMENT_OVER_TOTAL` | overpay | validasi client sebelum submit |
| 422 `REFERENCE_NO_REQUIRED` | transfer tanpa ref | required field dinamis di form |
| 409 `VOID_NOT_ALLOWED` | void sale sudah dibayar | arahkan user ke tombol **Refund** |
| 409 `TRANSITION_NOT_ALLOWED` | sudah VOIDED/RETURNED | disable aksi |
| 403 `FORBIDDEN` | role salah | sembunyikan menu (bukan cuma disable) |
| 429 `TOO_MANY_REQUESTS` | rate limit (login 10x/15m) | tampilkan countdown `Retry-After` |
| 401 | token | auto-refresh → logout |

### 2.5 Konvensi data
- Uang: `number` (float) → format `Intl.NumberFormat('id-ID')`, jangan hitung ulang total (ambil dari response)
- Qty bisa desimal (`NUMERIC(14,3)`) → dukung `0.25 kg`, tampilkan 3 desimal hanya jika perlu
- Waktu: ISO dari DB, render `Asia/Jakarta` (`BUSINESS_TZ`)

---

## 3. Halaman & Alur (mapping ke swagger)

### F1 — Auth & Shell
| Item | Endpoint | Detail |
|---|---|---|
| Login page | `POST /auth/login` | form user/pass; simpan `token`,`refresh_token`,`role`,`user`; handle 429 countdown |
| Session check | `GET /auth/me` | saat app boot |
| Layout | — | sidebar menu **berbasis role** (matrix §6); badge nama+role |

### F2 — Layar Kasir / POS (inti)
| Langkah | Endpoint | Detail |
|---|---|---|
| Cari produk | `GET /products?q=` / `?q=barcode` | debounce 300ms; scan barcode → langsung masuk cart |
| Cek stok | `GET /stock?product_id=` / respons product | tampilkan `qty_on_hand`; blok qty > stok (client) — server tetap penjaga |
| Satuan alt | item.`unit` | jika `product.unit_conversions` ada (mis. `pak`), pilih unit → harga = per unit ALT; FE tampilkan "1 pak = 5 pcs" |
| Cart + harga nego | — | default `harga_jual`; boleh edit turun; **validasi client: unit_price >= harga_beli** (DB 422 sebagai penjaga akhir) |
| PPN | `tax_percent` | optional input (default 0); total = subtotal + PPN dari server |
| Customer | `GET/POST /customers` | opsional walk-in; quick-add |
| Payment modal | `POST /sales` (+payment awal optional) | multi-metode dari `GET /payment-methods?active_only=true`; CASH: input `tendered_amount` → `change_amount` dari server; BANK_TRANSFER: `reference_no` wajib; **atau tanpa payment → UNPAID (DP/cicil nanti)** |
| Sukses → Receipt | `GET /sales/{id}/receipt` | render nota (§5), tombol Print + transaksi baru |
| Shift | `POST /cash-sessions/open` | guard: kasir wajib buka shift sebelum jual (jika owner menghendaki); tampilkan sisa kas |

### F3 — Penjualan, Piutang & Retur
| Fitur | Endpoint | Detail |
|---|---|---|
| Riwayat penjualan | `GET /sales?date_from&date_to&payment_status&status&q` | filter UNPAID/PARTIAL/PAID, COMPLETED/VOIDED/RETURNED |
| Detail | `GET /sales/{id}` | items + payments + refunds + paid/due |
| Pelunasan/DP | `POST /sales/{id}/payments` | partial; bar "sisa tagihan" realtime |
| Void | `POST /sales/{id}/void` | hanya UNPAID; alasan wajib; jika 409 → arahkan Refund |
| Refund/Retur | `POST /sales/{id}/refund` | untuk PAID (uang kembali, tercatat) & UNPAID; alasan wajib |
| Piutang customer | `GET /sales?payment_status=UNPAID` + `PARTIAL` | rekap per customer; total due |
| Cetak ulang nota | `GET /sales/{id}/receipt` | — |

### F4 — Stok & Barang Masuk
| Fitur | Endpoint |
|---|---|
| Dashboard stok | `GET /stock?in_stock_only&q` (qty_on_hand, nearest_expiry) |
| Detail per produk | `GET /stock/products/{id}` |
| Beli/barang masuk | `POST /purchases` (product, qty, unit_cost, expired_date optional, supplier) |
| Riwayat batch | `GET /purchases`, `GET /purchases/batches/{id}` |
| Ledger | `GET /stock/movements?type=&reference_type=` — lihat detail §4b |
| Alerts | `GET /alerts` → low_stock + expiring ≤30 hari (badge di sidebar) |
| Stok opname harian | `GET/POST /opnames`, `GET /opnames/{id}` — form auto `system_qty`, input `physical_qty`, selisih → ADJUSTMENT |

### F4b. Stock Movement Ledger — konsep & tampilan FE

**Konsep:** `stock_movements` adalah *ledger immutable* — satu-satunya sumber kebenaran riwayat stok. Setiap perubahan stok SELALU menghasilkan baris movement (tidak bisa di-UPDATE/DELETE; koreksi = baris baru). Stok saat ini (`qty_remaining` batch / `qty_on_hand` produk) adalah akumulasi dari ledger.

**Tiga tipe movement:**

| Type | `qty_change` | Dihasilkan otomatis oleh | Reference |
|---|---|---|---|
| `IN` | selalu `+` | `POST /purchases` (barang masuk/beli), `VOID`/`REFUND` sale (stok kembali) | `PURCHASE`→batch_id, `VOID`/`RETURN`→sale_id |
| `OUT` | selalu `−` | `POST /sales` (auto-deduct per item, per batch FIFO) | `SALE`→sale_id |
| `ADJUSTMENT` | `+` atau `−` | stok opname (selisih fisik vs sistem), koreksi rusak/hilang | `OPNAME`→opname_id |

**Penting untuk FE:**
- FE **tidak pernah** membuat/menghitung movement — semua oleh backend/trigger. FE hanya menampilkan.
- Setiap aksi user → efek ledger (pahami untuk toast/info): beli → `IN`; jual → `OUT`; void/refund → `IN` balik; simpan opname dengan selisih → `ADJUSTMENT`.
- Setelah mutasi stok, invalidate query `['stock']` dan `['movements']`.

**Halaman Ledger (menu: Stok → Riwayat Pergerakan):**
- Filter: `type` (IN/OUT/ADJUSTMENT), `product_id`, `reference_type`, `batch_id`, pagination (`limit/offset`)
- Tabel: `created_at` | produk | `batch_code` | badge tipe (IN=hijau `+`, OUT=merah `−`, ADJUSTMENT=kuning `±`) | `qty_change` bertanda | `unit_cost` | kolom **Sumber** (link drill-down):
  - `SALE` → buka detail penjualan (`GET /sales/{reference_id}`)
  - `PURCHASE` → buka detail batch (`GET /purchases/batches/{reference_id}`)
  - `VOID`/`RETURN` → detail sale terkait + label "stok dikembalikan"
  - `OPNAME` → detail opname (`GET /opnames/{reference_id}`) + selisihnya
- Baris `ADJUSTMENT` tampilkan note alasan (mis. "Opname: selisih −1") — ini konteks audit
- Footer rekap per filter: total IN, total OUT, net
- Akses: KASIR boleh lihat (read-only audit); tidak ada tombol edit/hapus (immutable by design, 405 dari server)

### F5 — Sesi Kasir
| Fitur | Endpoint |
|---|---|
| Buka shift | `POST /cash-sessions/open` (opening_cash) |
| Tutup shift | `POST /cash-sessions/{id}/close` (closing_cash fisik) → tampilkan `expected_cash` vs `closing_cash` + `difference` (konfirmasi selisih) |
| Riwayat shift | `GET /cash-sessions?user_id&status` |

### F6 — Owner (RBAC: OWNER saja)
| Fitur | Endpoint | Detail |
|---|---|---|
| Dashboard | `GET /reports/dashboard` | kartu: hari ini (pendapatan/laba kotor/trx), piutang, low stock, expiring, sesi open; top 5 produk |
| Laporan P&L | `GET /reports/pnl?month=YYYY-MM` | pendapatan, HPP, laba kotor, opex per kategori, laba bersih/netto, PPN, refund, piutang; export CSV (client-side) |
| Pengeluaran operasional | `GET/POST /expenses`, `PATCH /expenses/{id}` | kategori (GAJI_KARYAWAN/LISTRIK/INTERNET/bebas) |
| Metode pembayaran | `GET /payment-methods`, `POST/PATCH /payment-methods/{id}` | aktif/nonaktif, rekening bank — "set di menu" |
| Profil toko | `GET/PATCH /store` | header nota: nama, alamat, telp, NPWP, footer, logo |
| Master produk | `GET/POST /products`, `PATCH/DELETE` | sku, barcode, satuan, min_stock, unit_conversions, harga |

---

## 4. Struktur Response Penting (dari openapi.yaml)

```
SaleDetail: sale_no, status, payment_status, total_amount, tax_amount,
            items[{qty,unit_price,unit_cost,subtotal,note}], payments[], refunds[],
            paid_amount, due_amount, refunded_amount, is_test
Receipt:   { store{...}, sale{...}, items[], totals{subtotal,tax_amount,total_amount,
            paid_amount,refunded_amount,due_amount,change_total}, payments[], refunds[], footer }
Dashboard: { today{pendapatan,hpp,laba_kotor,jml_transaksi}, piutang_berjalan,
            low_stock_count, expiring_count, open_cash_sessions, top_products[] }
PnlReport: { pendapatan, hpp, laba_kotor, beban_operasional[], total_beban_operasional,
            laba_bersih, laba_netto, ppn_diterima, total_refund, piutang_berjalan }
```

---

## 5. Receipt / Nota (render dari `GET /sales/{id}/receipt`)

Layout thermal (58mm ≈ 32 kolon / 80mm ≈ 48 kolon), CSS `@media print`:

```
┌─────────────────────────────┐
│  [logo_url]                 │
│  TOKO BERKAH DIGITAL        │  <- store.name (bold, center)
│  Jl. Merdeka No. 123        │  <- store.address
│  0812-3456-7890             │  <- store.phone
│  NPWP: 01.234.567.8-901.000 │
│─────────────────────────────│
│ INV-20261004-139            │  <- sale.sale_no
│ 2026-10-04 06:17  Kasir:owner│
│ Customer: Bpk. Andi         │
│─────────────────────────────│
│ kartu perdana 20GB Tri      │
│  11 pcs x 24.500   269.500  │
│ voucher kuota 7GB           │
│   5 pcs x 13.000    65.000  │
│─────────────────────────────│
│ Subtotal            334.500 │
│ PPN                        0│
│ TOTAL               334.500 │
│ Tunai                     0 │
│ Kembalian                  0│
│ SISA TAGIHAN        334.500 │  <- PARTIAL/UNPAID sorot
│ [status: UNPAID]            │
│─────────────────────────────│
│ Terima kasih atas ...       │  <- store.receipt_footer
└─────────────────────────────┘
```
- Note item konversi satuan (`1 pak = 5 pcs`) tampil di bawah item
- Mode "struk retur" bila `sale.status=RETURNED` → tampilkan blok REFUND
- Print: buka window baru / iframe dengan CSS print (58/80mm), fallback PDF

---

## 6. Matriks Role → Menu

| Menu | KASIR | OWNER |
|---|---|---|
| POS (jual) | ✅ | ✅ |
| Riwayat penjualan + detail | ✅ | ✅ |
| Bayar/DP/Refund/Void | ✅ | ✅ |
| Piutang | ✅ (lihat) | ✅ |
| Stok, ledger, alerts | ✅ (lihat) | ✅ |
| Purchases (barang masuk) | ❌ | ✅ |
| Stok opname | ✅ | ✅ |
| Cash session (shift sendiri) | ✅ | ✅ (+lihat semua) |
| Dashboard, P&L, Expenses | ❌ (403) | ✅ |
| Payment methods, Store profile | ❌ (403) | ✅ |
| Master produk CRUD | ❌ | ✅ |

> Server sudah jaga 403; FE tetap sembunyikan menu (UX), jangan andalkan hide-only.

---

## 7. Ke concerns Multi-POS (2 terminal)

1. **Idempotency-Key per terminal** — UUID dari browser, retry aman
2. **Stok realtime** — React Query `refetchOnWindowFocus` untuk `/stock` saat POS idle; setelah checkout sukses → invalidate `['stock']`
3. **Konflik 409** — dua POS jual stok terakhir: pecinta kalah dapat 409 → toast + auto-refresh cart/stok
4. **sale_no dari server** — FE TIDAK generate nomor nota
5. **Clock** — semua waktu tampil dari DB (`sale_date`), bukan `Date.now()`

---

## 8. Fase Implementasi FE & Estimasi

| Fase | Scope | Estimasi | Acceptance (dari test_usecase.md) |
|---|---|---|---|
| FE-1 | Scaffold, API client (interceptor refresh, idempotency, error map), login, shell + RBAC menu | 2–3 hari | login owner/kasir/admin benar; 429 tampil countdown; auto-refresh jalan |
| FE-2 | Layar POS: search/scan, cart, nego price + validasi, unit conversion, payment modal multi-metode, receipt print | 4–5 hari | usecase #4: jual 11 Tri @24.500 + 5 voucher @13.000 → nota tercetak (#5) |
| FE-3 | Riwayat penjualan, detail, pelunasan/DP, void/refund, piutang | 3–4 hari | usecase #6: report & piutang ter-update; void PAID → diarahkan refund |
| FE-4 | Stok, purchases (barang masuk), ledger, alerts, opname | 3–4 hari | usecase #1–3: beli Tri 30 & voucher 20 via UI; opname harian |
| FE-5 | Cash session (buka/tutup shift + selisih) | 2 hari | tutup kas menampilkan expected vs fisik |
| FE-6 | Owner: dashboard, P&L + export CSV, expenses, payment methods, store profile, master produk | 4–5 hari | usecase #7: input gaji/listrik/internet → P&L laba bersih berubah |
| FE-7 | Polish: empty state, loading skeleton, print 58/80mm presisi, keyboard shortcut POS (F2=bayar, F4=cari), PWA optional | 2–3 hari | uji 2 browser simultan (2 POS) tanpa inkonsistensi |

Total: **± 20–26 hari kerja efektif** untuk MVP lengkap.

---

## 9. Definition of Done (keseluruhan)

- [ ] Semua 36 path swagger terpakai atau eksplisit tidak dipakai (ledger untuk admin audit)
- [ ] 7 usecase `test_usecase.md` lulus end-to-end dari UI
- [ ] Print nota rapi di thermal 58mm & 80mm (atau PDF fallback)
- [ ] 2 terminal simultan: idempotency + 409 handling terverifikasi
- [ ] Role matrix benar (kasir tidak melihat menu owner; akses langsung via URL → 403 page)
- [ ] Auto-refresh + logout + rate-limit countdown berfungsi
