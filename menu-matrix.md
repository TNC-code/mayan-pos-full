# Menu Matrix — OWNER vs KASIR

> Sumber kebenaran: `fe/lib/features/shell/nav_items.dart`, `fe/lib/router/route_guard.dart`,
> `src/routes/index.ts`, `plan-backend-v2-refund-rusak-opname-rbac.md` §3, **amandemen FE-11**,
> dan **WA-2** (menu "Order WA"). Matriks ini **final** — jangan dibalik.

## 1. Model RBAC (final FE-11)

| Role | Peran | Hak |
|---|---|---|
| **KASIR** | Operator | Semua **mutasi** POS & operasional harian: POS, master, pembelian, opname, retur distributor, shift, konfigurasi |
| **OWNER** | Monitor | **Semua GET/laporan** (read-only) **+ pengeluaran operasional sepenuhnya** (input + lihat) |

- Amandemen FE-11: pengeluaran operasional (`POST`/`PATCH`/`GET /expenses`) pindah ke **OWNER**
  sepenuhnya; KASIR tidak punya menu pengeluaran apa pun.
- Login: `username=owner` / `username=kasir1` (lihat `src/db/seed.ts`).
- Halaman awal setelah login: **KASIR → `/pos`**, **OWNER → `/dashboard`**.

## 2. Daftar Menu KASIR (11 menu)

| # | Menu | Path | Akses | Fungsi |
|---|---|---|---|---|
| 1 | POS | `/pos` | mutasi | Layar kasir: pilih produk, qty, proses pembayaran |
| 2 | Riwayat | `/sales` | baca | Daftar penjualan, detail nota, void, refund |
| 3 | Piutang | `/receivables` | baca | Nota UNPAID/PARTIAL per customer + pelunasan |
| 4 | Stok & Ledger | `/stock` | baca | Stok on hand, stok rusak, ledger pergerakan, alert |
| 5 | Barang Masuk | `/purchases` | mutasi | Pembelian supplier: batch, harga beli, expired |
| 6 | Master | `/master` | mutasi | Produk, kategori, jenis barang, satuan, customer |
| 7 | Opname | `/opname` | mutasi | Stok opname per batch + cause selisih |
| 8 | Retur Distributor | `/supplier-returns` | mutasi | Retur stok rusak ke supplier + settle dana |
| 9 | Order WA | `/order-books` | baca | Order book dari chat WhatsApp (badge PENDING) → proses jadi penjualan |
| 10 | Shift | `/shift` | mutasi | Buka/tutup shift kasir + selisih kas |
| 11 | Pengaturan | `/settings` | mutasi | Printer bluetooth, metode bayar, profil toko |

> Menu `Catat Pengeluaran` **dihapus** dari KASIR (11 → 10) oleh amandemen FE-11.
> **WA-2** menambah `Order WA` setelah `Retur Distributor` (10 → 11). Menu kasir
> di rail: `/order-books` (daftar + detail `/order-books/{id}`).

## 3. Daftar Menu OWNER (8 menu)

| # | Menu | Path | Akses | Fungsi |
|---|---|---|---|---|
| 1 | Dashboard | `/dashboard` | owner | Ringkasan hari ini, piutang, low stock, expiring, terlaris |
| 2 | P&L | `/reports/pnl` | owner | Laba rugi bulanan: pendapatan, HPP, laba kotor, opex |
| 3 | Laporan Opname | `/reports/opname` | owner | Rekap selisih opname per cause dan kategori |
| 4 | Pengeluaran | `/expenses` | owner | Daftar pengeluaran operasional (lihat + koreksi) |
| 5 | Catat Pengeluaran | `/expenses/new` | owner | Input/koreksi opex: gaji, listrik, internet, dst. |
| 6 | Riwayat | `/sales` | baca | Daftar penjualan (lihat saja, tanpa mutasi) |
| 7 | Stok & Ledger | `/stock` | baca | Stok on hand, stok rusak, ledger (lihat saja) |
| 8 | Opname | `/opname` | baca | Riwayat opname + selisih & nilai rugi/lebih (lihat saja) |

> Menu OWNER jadi **8** (6 matriks §3 + **Catat Pengeluaran** amandemen FE-11 +
> **Opname** read-only FE-6.2).

## 4. Perbedaan

| Kategori | Jumlah | Menu |
|---|---|---|
| **Hanya KASIR** (entri rail) | 8 | POS, Piutang, Barang Masuk, Master, Retur Distributor, **Order WA**, Shift, Pengaturan |
| **Hanya OWNER** | 5 | Dashboard, P&L, Laporan Opname, Pengeluaran, Catat Pengeluaran |
| **Bersama (read-only utk OWNER)** | 3 | Riwayat (`/sales`), Stok & Ledger (`/stock`), Opname (`/opname`) |

> **Order WA** masuk "Hanya KASIR" karena **entri rail-nya** hanya untuk kasir
> (menu OWNER tetap 8, menu KASIR jadi 11). Namun **route**-nya (`/order-books`,
> `/order-books/{id}`) berstatus `sharedRead` — OWNER boleh membukanya lewat
> deep-link/refresh dan isinya read-only: tombol pilih produk, ubah qty, hapus
> item, Tandai Diproses, Batalkan, dan Proses jadi Penjualan tidak dirender,
> digantikan `OwnerNotice`. Semua mutasi `/order-books/*` tetap 403 untuk OWNER.

### Perbedaan sifat akses
- **KASIR** boleh `POST`/`PATCH`/`DELETE` mutasi operasional (POS, master, pembelian, opname,
  retur, shift, pengaturan).
- **OWNER** hanya `GET` — kecuali: `POST`/`PATCH`/`GET /expenses` dan `/reports/*` justru
  **OWNER-only** (amandemen FE-11).
- Deep-link ke menu role lain → guard `go_router` redirect ke home + snackbar:
  - KASIR buka menu OWNER → *"Halaman ini khusus owner."*
  - OWNER buka menu KASIR → *"Menu ini khusus kasir — owner hanya melihat laporan."*

### Catatan unik
- **OWNER boleh input & melihat pengeluaran** (`GET`/`POST`/`PATCH /expenses`) — KASIR **tidak**
  punya menu pengeluaran dan mendapat `403` untuk `GET`/`POST`/`PATCH /expenses`.
- Both role boleh baca: `/sales`, `/stock`, `/opnames` (detail), `/supplier-returns` (detail),
  `/order-books` & `/order-books/{id}` (WA-2), `/cash-sessions`, `/store` (profil toko).
  Untuk **Order WA** owner **hanya** bisa lewat deep-link (tidak ada entri di rail OWNER).
- Yang berubah dari RBAC lama: OWNER di-block dari semua mutasi **kecuali pengeluaran**; input
  payment-methods & profil toko tetap di KASIR.

## 5. Peta Menu → Endpoint API

### Menu KASIR

| Menu | Path UI | Endpoint (openapi `servers.url = /api/v1`) | Izin |
|---|---|---|---|
| POS | `/pos` | `POST /sales`, `POST /sales/{id}/payments`, `GET /products`, `GET /sales` | KASIR (mutasi) |
| Riwayat | `/sales` | `GET /sales`, `GET /sales/{id}`, `GET /sales/{id}/receipt`, `GET /sales/{id}/payments`, `POST /sales/{id}/void`, `POST /sales/{id}/refund` | GET both · mutasi KASIR |
| Piutang | `/receivables` *(UI-only)* | `GET /sales?payment_status=UNPAID,PARTIAL`, `GET /sales/{id}/payments`, `POST /sales/{id}/payments` | GET both · bayar KASIR |
| Stok & Ledger | `/stock` | `GET /stock`, `GET /stock/damaged`, `GET /stock/movements`, `GET /stock/products/{id}`, `GET /alerts` | both |
| Barang Masuk | `/purchases` | `GET /purchases`, `POST /purchases`, `GET /purchases/batches/{id}` | GET both · POST KASIR |
| Master | `/master` | `GET/POST/PATCH/DELETE /products`, `GET/POST/PATCH /categories`, `GET/POST /product-types`, `GET/POST/PATCH /customers` | GET both · mutasi KASIR |
| Opname | `/opname` | `GET /opnames`, `POST /opnames`, `GET /opnames/{id}` | GET both · POST KASIR |
| Retur Distributor | `/supplier-returns` | `GET /stock/damaged`, `POST /supplier-returns`, `GET /supplier-returns`, `GET /supplier-returns/{id}`, `POST /supplier-returns/{id}/settle` | GET both · mutasi KASIR |
| Order WA | `/order-books`, `/order-books/{id}` | `GET /order-books`, `GET /order-books/{id}`, `PATCH /order-books/{id}/items/{itemId}`, `DELETE /order-books/{id}/items/{itemId}`, `POST /order-books/{id}/status`, `POST /order-books/{id}/convert`, `GET /products`, `GET /stock` | GET both · mutasi KASIR |
| Shift | `/shift` | `GET /cash-sessions`, `GET /cash-sessions/{id}`, `POST /cash-sessions/open`, `POST /cash-sessions/{id}/close` | GET both · mutasi KASIR |
| Pengaturan | `/settings` | `GET/POST/PATCH /payment-methods`, `GET /store`, `PATCH /store` | GET both · mutasi KASIR |

### Menu OWNER

| Menu | Path UI | Endpoint | Izin |
|---|---|---|---|
| Dashboard | `/dashboard` | `GET /reports/dashboard`, `GET /alerts` | OWNER |
| P&L | `/reports/pnl` | `GET /reports/pnl?month=YYYY-MM` | OWNER |
| Laporan Opname | `/reports/opname` | `GET /reports/opname?month=YYYY-MM` | OWNER |
| Pengeluaran | `/expenses` | `GET /expenses`, `GET /expenses/{id}` | OWNER |
| Catat Pengeluaran | `/expenses/new` | `POST /expenses`, `PATCH /expenses/{id}` | OWNER |
| Riwayat | `/sales` | `GET /sales`, `GET /sales/{id}`, `GET /sales/{id}/receipt`, `GET /sales/{id}/payments` | both (read-only) |
| Stok & Ledger | `/stock` | `GET /stock`, `GET /stock/damaged`, `GET /stock/movements`, `GET /stock/products/{id}`, `GET /alerts` | both (read-only) |
| Opname | `/opname` | `GET /opnames`, `GET /opnames/{id}` | both (read-only) |

> `/receivables` adalah **route UI saja** — tidak ada endpoint `/receivables` di openapi;
> datanya dari `GET /sales` difilter status pembayaran + pelunasan via `POST /sales/{id}/payments`.

## 6. Tabel RBAC Lengkap per Endpoint (openapi v2.1.0)

| Endpoint | Method | KASIR | OWNER |
|---|---|---|---|
| `/auth/login`, `/auth/refresh` | POST | publik | publik |
| `/auth/me`, `/auth/logout`, `/store` | GET/POST | ✅ | ✅ |
| `/products`, `/products/{id}` | GET | ✅ | ✅ |
| `/products`, `/products/{id}` | POST/PATCH/DELETE | ✅ | ❌ 403 |
| `/categories`, `/product-types` | GET | ✅ | ✅ |
| `/categories`, `/categories/{id}`, `/product-types` | POST/PATCH | ✅ | ❌ 403 |
| `/customers`, `/customers/{id}` | GET | ✅ | ✅ |
| `/customers`, `/customers/{id}` | POST/PATCH | ✅ | ❌ 403 |
| `/payment-methods`, `/payment-methods/{id}` | GET | ✅ | ✅ |
| `/payment-methods`, `/payment-methods/{id}` | POST/PATCH | ✅ | ❌ 403 |
| `/purchases`, `/purchases/batches/{id}` | GET | ✅ | ✅ |
| `/purchases` | POST | ✅ | ❌ 403 |
| `/sales`, `/sales/{id}`, `/sales/{id}/receipt`, `/sales/{id}/payments` | GET | ✅ | ✅ |
| `/sales`, `/sales/{id}/payments`, `/sales/{id}/void`, `/sales/{id}/refund` | POST | ✅ | ❌ 403 |
| `/cash-sessions`, `/cash-sessions/{id}` | GET | ✅ | ✅ |
| `/cash-sessions/open`, `/cash-sessions/{id}/close` | POST | ✅ | ❌ 403 |
| `/opnames`, `/opnames/{id}` | GET | ✅ | ✅ |
| `/opnames` | POST | ✅ | ❌ 403 |
| `/stock`, `/stock/damaged`, `/stock/movements`, `/stock/products/{id}`, `/alerts` | GET | ✅ | ✅ |
| `/supplier-returns`, `/supplier-returns/{id}` | GET | ✅ | ✅ |
| `/supplier-returns`, `/supplier-returns/{id}/settle` | POST | ✅ | ❌ 403 |
| `/order-books`, `/order-books/{id}` | GET | ✅ | ✅ (read-only, WA-2) |
| `/order-books` | POST | ✅ | ❌ 403 (bot internal key / kasir) |
| `/order-books/{id}/items/{itemId}`, `/order-books/{id}/status`, `/order-books/{id}/convert` | PATCH/DELETE/POST | ✅ | ❌ 403 |
| `/expenses`, `/expenses/{id}` | POST/PATCH | ❌ 403 | ✅ (**OWNER-only**, amandemen FE-11) |
| `/expenses`, `/expenses/{id}` | GET | ❌ 403 | ✅ (**OWNER-only**) |
| `/reports/dashboard`, `/reports/pnl`, `/reports/opname` | GET | ❌ 403 | ✅ (**OWNER-only**) |
| `/store` | PATCH | ✅ | ❌ 403 |

## 7. Temuan Inkonsistensi di `openapi.yaml` — SUDAH DIPERBAIKI

Lima deskripsi 403 endpoint OWNER-only salah menyebut role, plus kalimat `x-rbac`
rusak. Semua sudah dikoreksi (cek git diff openapi.yaml):

| Endpoint | Deskripsi lama (salah) | Sekarang |
|---|---|---|
| `GET /reports/dashboard` | "OWNER tidak diizinkan" | "KASIR tidak diizinkan (laporan khusus OWNER)" |
| `GET /expenses` | "OWNER tidak diizinkan" | idem |
| `GET /expenses/{id}` | "OWNER tidak diizinkan" | idem |
| `GET /reports/pnl` | "OWNER tidak diizinkan" | idem |
| `GET /reports/opname` | "OWNER tidak diizinkan" | idem |

`PATCH /store` (OWNER 403) tidak berubah — memang benar.

## 8. Aturan Kasbon (checkout tanpa pembayaran)

Checkout **tanpa** `payment` (nota `UNPAID`, bayar saat/setelah pengiriman — pola COD/kasbon)
**wajib menyertakan `customer_id`** (`src/controllers/schemas.ts` superRefine → 400 `VALIDATION_ERROR`).

- Bayar langsung (payment ada) → customer opsional (walk-in).
- Alasan: piutang tanpa nama tidak bisa ditagih & tidak muncul rapi di menu Piutang.
- Terdokumentasi di `openapi.yaml` (`SaleInput.customer_id` + deskripsi `POST /sales`).
- Diuji e2e: `x12` kasbon tanpa customer → 400.
