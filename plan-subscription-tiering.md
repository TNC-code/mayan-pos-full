# Plan — Subscription Tiering (keputusan produk, belum dieksekusi)

> **Status: 📋 DECIDED, BELUM DIIMPLEMENTASI** · Disepakati 2026-10-08
> Semua gate **wajib di backend** (bukan cuma disembunyikan di FE).

## 1. Pemetaan fitur per tier (FINAL)

| Tier | Fitur |
|---|---|
| **Gratis** | POS (kasir), stok & batch costing, barang masuk, opname, ledger, keranjang desimal, piutang dasar |
| **Basic** | Semua Gratis **+ Laba rugi, Laporan per Produk (+ rata-rata/hari), filter bulan lampau, export CSV, multi-kasir, shift** |
| **Pro** | Semua Basic **+ WA bot & order book, retur distributor, riwayat tanpa batas** |
| **Outlet** | Semua Pro **+ multi-outlet, konsolidasi laporan antar cabang, API** |

Keputusan eksplisit user: **WA bot = fitur Pro** (pembeda utama tier Pro).

## 2. Prinsip gating

- `store_profile.plan` (mis. `free | basic | pro | outlet`) — sumber kebenaran tunggal;
  dikembalikan lewat `/auth/me` agar FE bisa menyesuaikan menu.
- Middleware tier-gate per route group: `/reports/*` ≥ Basic, `/export/*` ≥ Basic,
  `/order-books*` + X-Internal-Key WA ≥ Pro, `/supplier-returns*` ≥ Pro.
- Gate paling tegas = **export CSV** (hard gate) dan **riwayat lama**:
  Gratis hanya bulan berjalan, Basic 12 bulan, Pro tanpa batas — data tetap tersimpan
  untuk semua tier (mendorong upgrade tanpa merusak operasional).
- FE: sembunyikan/nonaktifkan menu sesuai plan + halaman upsell (bukan error mentah).

## 2b. Role × Plan (dua dimensi berbeda — FINAL)

Akses fitur = `plan toko` **∩** `role user`. Role (OWNER/KASIR) = otorisasi per user
di dalam toko; Plan = hak toko, diwarisi semua user-nya.

| Fitur | Plan toko | Role user |
|---|---|---|
| POS, barang masuk, opname, ledger | semua | KASIR + OWNER |
| Laba rugi, laporan per produk, export CSV | ≥ Basic | **OWNER saja** (aturan kini: `/reports/*` memang OWNER-only — tetap) |
| Multi-kasir & shift | ≥ Basic | OWNER kelola, KASIR pakai |
| WA bot & order book | ≥ Pro | akun sistem `bot` (`X-Internal-Key`) — bukan role manusia |
| Multi-outlet, konsolidasi | ≥ Outlet | OWNER |

Konsekuensi:
1. Plan Basic **tidak** membuat kasir bisa lihat laporan — gating ganda:
   middleware plan (per store) dijalankan dulu, lalu guard role yang sudah ada.
2. Tier Gratis dibatasi **1 akun kasir** — dorongan upgrade natural ke Basic.
3. WA bot = fitur toko (akun bot), bukan soal role manusia.

## 3. Urutan eksekusi yang disarankan (belum dimulai)

1. **Laporan Penjualan per Produk** (lihat §10 rencana batch costing; + rata-rata/hari + CSV)
   — fitur Basic pertama; bangun sekarang selagi gate belum ada, sudah terpakai untuk
   pembukuan internal sendiri.
2. Kolom `plan` + middleware + payload `/auth/me`.
3. Halaman upsell + penyembunyian menu di FE.
4. Multi-outlet & konsolidasi (Outlet) — jauh, butuh redesign tenant (`store_profile` per cabang).
