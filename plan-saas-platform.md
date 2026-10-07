# Plan Platform SaaS Multi-Tenant — POS Inventory (**Mayan POS**)

> **STATUS: ⏸️ BACKLOG — DITUNDA (keputusan user).** Dokumen siap eksekusi, tapi SAAS-0..7 BELUM dikerjakan.
> Prioritas saat ini: operasional Mayan POS single-tenant (fitur P0 POS + go-live).
> **KEPUTUSAN FINAL (user, disetujui):** merk = **Mayan POS** (console: "Mayan POS Console").
> Domain `quotaku.com` tetap dipakai (sudah berjalan); subdomain wildcard `*.api.quotaku.com` **DITUNDA** — lihat §12 keputusan #3.

> **Status: DRAF PERENCANAAN — belum ada implementasi.** Dokumen ini hanya rencana; tidak ada kode
> `src/`, `fe/`, migration, atau perubahan DB yang dibuat oleh dokumen ini.
> Sumber konteks: `fase.md` · `plan-backend-v2-refund-rusak-opname-rbac.md` · `openapi.yaml` (41 path, v2.1.0) ·
> `src/db/migrate.ts` (0001–0008) · `fe/plan-fe-flutter-tablet.md` + `fe/tasklist-fe.md` (FE-0…FE-13).
> Eksekusi nanti: `tasklist-saas-platform.md` (checklist per fase) · Console: `fe-super/README.md`.

## Daftar Isi
1. [Ringkasan & Tujuan](#1-ringkasan--tujuan)
2. [Konteks Eksisting yang Dipakai](#2-konteks-eksisting-yang-dipakai)
3. [Arsitektur](#3-arsitektur)
4. [Keputusan Multi-Tenancy](#4-keputusan-multi-tenancy)
5. [Skema DB Platform](#5-skema-db-platform)
6. [Matriks Langganan](#6-matriks-langganan)
7. [Insight Bisnis Langganan](#7-insight-bisnis-langganan)
8. [Analisa Market Distributor (ETL + Dashboard)](#8-analisa-market-distributor-etl--dashboard)
9. [Perubahan Aplikasi Flutter](#9-perubahan-aplikasi-flutter)
10. [Fase Implementasi](#10-fase-implementasi)
11. [Risiko & Mitigasi](#11-risiko--mitigasi)
12. [Decision Points (menunggu user)](#12-decision-points-menunggu-user)
13. [Referensi](#13-referensi)

---

## 1. Ringkasan & Tujuan

### 1.1 Yang sudah ada (tidak diubah bentuknya)

| Aspek | Kondisi sekarang |
|---|---|
| Backend tenant | Express + TypeScript, **raw SQL tanpa ORM**, PostgreSQL 16, 41 path, RBAC KASIR=operator / OWNER=laporan+opex |
| Skema tenant | `inventory_db`: 13 tabel inti (produk, batch, movement, sales, sale_items, payment, opname, user) + tabel turunan migration 0002–0008 (opex, refunds, refund_items, cash_sessions, refresh_tokens, supplier_returns(+items), store_profile, idempotency_keys) + 11 trigger penjaga (ledger immutable, anti-oversell, harga ≥ beli, anti-overpay) |
| Otentikasi | JWT (12 jam) + refresh (7 hari), bcrypt, role di DB |
| FE | Flutter tablet Android landscape, FE-0…FE-13 selesai, base URL via `--dart-define` (default produksi `https://invcash.quotaku.com/api/v1`) |
| Skrip ops | `scripts/backup.sh` (pg_dump harian, retensi 14 hari), `npm run e2e`, `npm run concurrency`, `npm run mark-test-data` |

### 1.2 Yang harus dibangun

1. **Platform SaaS**: superadmin mengelola tenant, plan, outlet, tagihan; owner tenant daftar sendiri lewat **web**.
2. **Pemisahan data per tenant**: satu instance POS bisa dipakai banyak toko tanpa saling membaca data.
3. **Analisa lintas tenant untuk riset pembelian distributor**: omzet seluruh tenant + produk yang paling laku lintas tenant (termasuk produk free-text yang perlu dinormalisasi ke taksonomi platform).
4. **Perubahan aplikasi Flutter** agar tenant-aware (login pakai kode toko, switcher outlet, status langganan, read-only saat kedaluwarsa).

### 1.3 Insight sinergi distributor (inti nilai bisnis)

Platform ini bukan sekadar "POS jadi SaaS". Pemilik platform adalah **distributor** (kartu pulsa, voucher, kosmetik, vitamin, aksesoris HP, stok grocer). Sinerginya:

```
      +-Tenant daftar (SaaS)-----------+   owner warung = pembeli
      |   ▼                             |
      |  Jual produk (POS)              |   HPP + harga beli tercatat
      |   ▼                             |
      |  PETA PERMINTAAN  (agregat)    |   "Produk apa yang dicari 300 toko?"
      |   ▼                             |
      |  Riset pembelian distributor   |   kartu, jumlah stok, waktu
      |   ▼                             |
      | Tindakan nyata: tambah katalog, harga, promo, bundling   ◀──Margin distributor
      +---------------------------------+
```

Tiga nilai konkret:

| Nilai | Mekanisme | Mengapa kuat |
|---|---|---|
| **Riset permintaan pasar** | ETL harian menjumlah `sale_items` seluruh tenant (produk, qty, omzet, HPP) | 300 toko mikro = sinyal yang tidak dimiliki pesaing single-toko; MOQ & jadwal restock distributor jadi berbasis data, bukan perkiraan |
| **Revenue ganda (SaaS + barang)** | Langganan + margin stok ke tenant yang beli dari platform | Satu pelanggan, dua sumber pendapatan; tenant yang tutup tidak langsung churn karena sudah terlanjur \"terintegrasi stok\" dengan distributor |
| **Data sebagai produk** (fase lanjut) | Agregat anonim (tanpa PII) untuk riset vendor/pabrikan | Opsional; butuh kebijakan privasi tertulis + izin tenant (§8.7) |

Batasan yang dijaga: agregat lintas tenant **hanya angka penjualan/produk**, tidak ada PII (nama/HP pelanggan, identitas kasir), dan tidak pernah ditampilkan publik — hanya di console superadmin & ekspor riset internal distributor.

---

## 2. Konteks Eksisting yang Dipakai

Keputusan di dokumen ini leverages existing, bukan mengganti:

| Aset existing | Dipakai untuk |
|---|---|
| `inventory_pos_migration_v2.sql` (13 tabel + trigger) | Freeze sebagai **template DB** untuk tenant baru (`tpl_quotaku`) |
| `src/db/migrate.ts` 0001–0008 (idempotent, forward-only) | Dijalankan ulang per tenant DB (fan-out) sampai migration 0009 (outlet + entitlement) |
| `scripts/backup.sh` (pg_dump per DB) | Diperluas jadi loop per tenant (`--dbname`) + retensi per plan |
| `openapi.yaml` (41 path) | Kontrak tenant API **tidak berubah**; Ditambah path baru (outlet, subscription, me) di versi 3.0.0 |
| Error map §3 `fase.md` | Diperluas kode 402/403 baru untuk limit & langganan |
| `fe/lib/core/config/env.dart` (base URL `--dart-define`) | Diganti jadi **tenant resolver** (kode toko → base URL), default tetap bisa dipakai untuk dev single-tenant |
| `menu-matrix.md` (kasir 10 menu, owner 8 menu) | Tidak berubah; tambahan layar langganan hanya untuk OWNER |

Yang **tidak** berubah: aturan ledger immutable, anti-oversell, harga ≥ HPP, anti-overpay, RBAC KASIR/OWNER, 41 path lama.

---

## 3. Arsitektur

### 3.1 Diagram

```
                       PEMAKAI (publik)
   ┌────────────────────────┐        ┌──────────────────────────┐
   │ Owner toko (registrasi)│        │ Superadmin distributor   │
   │  browser → web         │        │  browser → console       │
   └───────────┬────────────┘        └────────────┬─────────────┘
               │  POST /registrations             │  JWT superadmin
               ▼                                 ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ DOMAIN PUBLIK                                                              │
  │  www.quotaku.com            → web registrasi + marketing (SvelteKit)     │
  │  app.quotaku.com  (:4000)   → Mayan POS Console (superadmin/ops)   │
  │  api.quotaku.com   (:4001)   → PLATFORM API (Express) → platform_db       │
  │  <kode>.api.quotaku.com     → TENANT API (Express, proses tenant_api.ts)  │
  │    atau  api.quotaku.com/api/v1  + header X-Tenant-Code: <kode>            │
  └──────────────────────────────────────────────────────────────────────────┘

  PLATFORM SIDE                          TENANT SIDE
  ┌────────────────────────────┐         ┌──────────────────────────────────────┐
  │ platform_db (PostgreSQL 16)│         │ tenant_api.ts  (Express, 41 path+)  │
  │  tenants, plans, subs,     │         │  middleware berurutan:                │
  │  invoices, platform_users, │         │   1 resolveTenant (host/header/env)   │
  │  outlets, audit_log,       │         │   2 pool cache (pg Pool per tenant)  │
  │  usage_daily, product_sales│         │   3 auth (JWT wajib punya claim tid)  │
  │  provisioning_jobs,        │◀────────┤   4 entitlement (cache 60 detik)     │
  │  job_runs                  │ service │   5 RBAC KASIR/OWNER (tetap)         │
  └────────────▲───────────────┘  key    └──────────┬───────────────────────────┘
               │  provisioning                          │ query langsung
               │  CREATE DATABASE ... TEMPLATE          ▼
               │                              ┌───────────────────────────────┐
  ┌────────────┴───────────────┐              │ t_<kode> (PostgreSQL 16)     │
  │ tpl_quotaku  (DB template) │─────────────▶│ 13+ tabel, 11 trigger,        │
  │ freeze 0001–0008 + 0009    │  clone <1 dtk │ user_account per tenant      │
  │ seed master per jenis usaha│              │ outlet + tenant_entitlements │
  └────────────────────────────┘              └───────────────────────────────┘
                                                        ▲
  ANALISA (market distributor)                          │ read-only
  ┌──────────────────────────────────────────┐          │
  │ Scheduler (cron 01:15 Asia/Jakarta)       │──────────┘
  │  platform/jobs/etl-omzet.ts              │  query agregat per tenant
  │  per tenant: extract → normalisasi        │
  │  → UPSERT usage_daily + product_sales     │
  │  → tenant_product_sales_daily             │
  └───────────────┬───────────────────────────┘
                  ▼
        platform_db.usage_daily / tenant_product_sales_daily
        → dashboard console §8.5 + ekspor CSV §8.6
```

### 3.2 Komponen & port

| Komponen | Dev port | Prod | Stack | Peran |
|---|---|---|---|---|
| `platform/` (Platform API) | **4001** | `api.quotaku.com` | Express + TS, **raw SQL** (konsisten dengan repo) | auth superadmin, CRUD tenant/plan/subscription/invoice, registrasi publik, provisioning, entitlement, analitik, ekspor |
| `fe-super/` (Console) | **4000** | `app.quotaku.com` | **SvelteKit + Tailwind** | UI superadmin/ops |
| `www` (web registrasi) | 4000 (route group) | `www.quotaku.com` | SvelteKit (SSR) | Landing, wizard registrasi, halaman harga, status akun |
| `tenant_api.ts` (Tenant API) | **3000** (dipisah dari `server.ts` produksi) | `<kode>.api.quotaku.com` | Express + TS, kode existing | 41 path existing + `outlets` + `subscription` + `me` |
| `platform_db` | `platform_db` | `platform_db` | PostgreSQL 16 | Data platform (bukan data transaksi tenant) |
| `t_<kode>` | — | — | PostgreSQL 16 | Data transaksi 1 tenant (1 DB per tenant) |
| `tpl_quotaku` | — | — | PostgreSQL 16 | DB template untuk clone |

**Keputusan proses**: `src/server.ts` (single-tenant, `:3000`) **dipertahankan** sebagai cara lama (fallback/dev & tenant-1 bisa tetap jalan persis seperti sekarang). Entry baru `src/tenant_api.ts` berbagi **service & controller yang sama**, hanya menambahkan middleware tenant. Jadi risiko regresi tenant-1 = rendah, dan matriks 41 path tidak berubah.

### 3.3 Domain & routing

| Pola | Untuk | Catatan |
|---|---|---|
| `www.quotaku.com` | Landing, harga, registrasi | Publik, tanpa auth |
| `app.quotaku.com` | Console superadmin | Auth superadmin (JWT) |
| `api.quotaku.com` | Platform API | Auth superadmin / tenant-service-key |
| `api.quotaku.com/api/v1/...` + `X-Tenant-Code: <kode>` | Tenant API **wildcard** | Tanpa DNS per tenant; dipakai app FE & juga `acme.api.quotaku.com` |
| `acme.api.quotaku.com/api/v1/...` | Tenant API **subdomain** | Host → `acme`; satu server (wildcard cert `*.api.quotaku.com`) |

Prioritas resolusi tenant (lihat §4.5): **Host subdomain** → `X-Tenant-Code` → `?tenant=` (hanya untuk file unduhan/export & Swagger) → `DEFAULT_TENANT_CODE` (tenant-1, kompatibilitas).

### 3.4 CORS & base URL

Sekarang `src/app.ts` memakai `cors()` tanpa whitelist (terbuka semua origin). Setelah ada multi-tenant, CORS harus diperketat:

| Asal | Origin yang diizinkan |
|---|---|
| Tenant API | `https://app.quotaku.com`, `https://www.quotaku.com`, `*.api.quotaku.com`, `http://localhost:4000`, `http://localhost:*` (dev) |
| Platform API | `https://app.quotaku.com`, `http://localhost:4000` (dev) |
| Header tambahan tenant API | `X-Tenant-Code`, `X-Outlet-Id`, `Idempotency-Key`, `X-Platform-Version` |

FE (Flutter) tidak butuh CORS (bukan browser), tapi `fe/web` & mode Chrome butuh — tetap diizinkan lewat allowlist.

**Base URL**: `https://invcash.quotaku.com/api/v1` (default produksi FE saat ini) **tetap dipakai** sebagai host tenant-1 (backward compatible), lalu berkembang jadi `https://api.quotaku.com/api/v1` + `X-Tenant-Code`. Tutorial/QR di struk memakai `acme.api.quotaku.com`.

---

## 4. Keputusan Multi-Tenancy

### 4.1 Kandidat model

| | **A. DB-per-tenant** | **B. Schema-per-tenant** | **C. Shared + `tenant_id`** |
|---|---|---|---|
| Bentuk | 1 database per tenant: `t_acme`, `t_beli` | 1 database, 1 schema per tenant: `acme.*` | 1 database, 1 schema `public`, kolom `tenant_id` di semua tabel |
| Routing koneksi | `Pool` per tenant (cache) | `search_path` per koneksi | 1 pool, filter `tenant_id` |
| Isolasi | **Fisik** (level database) | Logis (level schema) | Logis (level baris) |
| Backup per tenant | `pg_dump -d t_acme` (satu perintah) | `pg_dump -n acme` (restore lebih rawan) | `pg_dump` penuh + filter (memerlukan splitter) |
| Perubahan kode tenant API | **Nol** (SQL existing tetap) | Besar (semua `public.` harus hilang) | Sangat besar (semua query + FK + trigger) |
| Skor biaya | ±10–25 MB/tenant kosong; total 200 tenant ≈ 3–5 GB | 0 | 0 |
| Batas koneksi | 1 pool/tenant (lihat §11 risiko) | 1 pool total | 1 pool total |

### 4.2 Analisa per opsi

**A. DB-per-tenant**

- ✅ **Nol perubahan SQL bisnis.** Semua query memakai skema hardcode `public.` (mis. `INSERT INTO public.sale_items`, `UPDATE public.stock_batches`). Yang perlu diubah hanya *koneksi* (`pool` per tenant), bukan query.
- ✅ **Trigger & function tetap aman.** 11 trigger penjaga (`fn_sale_item_validate`, `fn_stock_movement_apply`, `trg_stock_movement_immutable`, ...) yang menunjuk `public.*` langsung work di setiap DB tanpa duplikasi.
- ✅ **Revoke akses jadi mekanisme teknis**: `REVOKE CONNECT ON DATABASE t_acme FROM app_role` → tenant suspended/offline tanpa menyentuh kode aplikasi.
- ✅ **Backup & restore per tenant** persis mengikuti `scripts/backup.sh` yang sudah ada (loop `pg_dump --dbname`).
- ✅ **Migrasi dari kondisi sekarang nol downtime**: `inventory_db` didaftarkan apa adanya sebagai tenant pertama.
- ⚠️ Koneksi: N tenant × pool ⇒ banyak koneksi. Mitigasi §11 (pool cache + idle timeout + PgBouncer saat >100 tenant).
- ⚠️ Migrasi harus fan-out ke semua DB (juga perlu di §10 SAAS-0/1).

**B. Schema-per-tenant**

- ❌ **Blokir teknis utama**: seluruh SQL & 11 trigger function memakai prefix `public.`. Dengan 1 DB, `public.` = 1 tenant saja → harus menghapus/mengganti prefix di **semua** query & trigger (ratusan baris), dan tiap schema butuh **salinan** trigger/function sendiri (atau `search_path` yang rapuh saat trigger dipanggil).
- ⚠️ `search_path` per koneksi + pool = sumber bug "kebaca data tenant lain" bila satu koneksi dipakai dua tenant (bisa dimitigasi dengan pool per tenant juga, jadi DB-per-tenant tetap lebih jelas).
- ✅ Biaya & jumlah koneksi paling rendah.

**C. Shared + `tenant_id`**

- ❌ **Paling berisiko** untuk model raw SQL kita: tidak ada ORM yang memaksa filter tenant ⇒ setiap query yang lupa `WHERE tenant_id` = kebocoran data antar pelanggan. Ini risiko tingkat tertinggi: satu baris SQL yang lupa filter = insiden kebocoran data antar pelanggan.
- ❌ Trigger ledger immutable perlu diubah untuk ikut mengecek `tenant_id`; FK jadi komposit; `sale_items`/batch jadi jauh lebih rumit.
- ❌ Backup/purge per tenant (permintaan hapus data) hampir mustahil secara sederhana.
- ❌ Analitik lintas tenant jadi "terlalu mudah" — justru jadi **risiko privasi**, bukan keuntungan.
- ✅ Hanya 1 DB & 1 pool (murah di skala sangat besar).

### 4.3 Keputusan

> **REKOMENDASI: A. DB-per-tenant** (satu database per tenant, satu cluster PostgreSQL 16, satu proses `tenant_api.ts` dengan pool cache per tenant; DB baru per tenant di-migrate dengan fan-out dari 1 perintah).
> Alasan penentu: (1) raw SQL tanpa ORM + 11 trigger dengan prefix `public.` ⇒ opsi B/C menuntut rewrite besar dengan risiko kebocoran data; (2) backup/restore & hapus-data per tenant jadi satu perintah; (3) onboarding cepat (`CREATE DATABASE ... TEMPLATE` < 1 detik); (4) kompatibel penuh dengan `inventory_db` existing sebagai tenant #1.

### 4.4 Provisioning (alur berjenjang)

| # | Langkah | Detail |
|---|---|---|
| 1 | Registrasi | `POST /api/v1/platform/registrations` (publik, rate-limit 3/15m/IP) → validasi kode tenant, jenis usaha, plan, email/HP owner, langsung buat `tenants` status `PROVISIONING` + `tenant_provisioning_jobs` (checkpoint) + trial 14 hari. Respons 201: `{tenant_code, admin_username, temp_password, base_url, onboarding_token}`. |
| 2 | Clone DB | `CREATE ROLE t_<kode>` + `CREATE DATABASE t_<kode> OWNER t_<kode> TEMPLATE tpl_quotaku` (butuh 1–2 detik; `tpl_quotaku` tidak boleh punya koneksi aktif). |
| 3 | Migrasi | Jalankan migration runner yang sama (`migrate.ts` + 0009) ke `t_<kode>`; cek `verifyBaseline()` OK. |
| 4 | Seed master | `platform/seeds/<jenis_usaha>.sql` → kategori, tipe produk, metode bayar (QRIS/Transfer/Tunai), 1 outlet default, `store_profile`, `tenant_entitlements` (plan + flag + limit). |
| 5 | Akun owner | `user_account` OWNER (bcrypt) + 1 KASIR opsional; username = kode tenant (login Flutter tetap sederhana). |
| 6 | Aktivasi | Subdomain aktif (`<kode>.api.quotaku.com` via wildcard DNS+TLS), `tenants.status=ACTIVE`, entri `tenant_entitlements` disinkron, `audit_log` ditulis, `usage_daily` mulai terisi. |
| 7 | Kvarian | `admin.quotaku.com` → tenant baris `is_admin=true` (akun internal distributor, tanpa billing, DB-nya `inventory_db`). |

6 jenis usaha (umum untuk semua plan, template berbeda): `WARUNG_SEMBAKO`, `KONTER_PULSA`, `MINIMARKET`, `KOSMETIK`, `VITAMIN_SUPLEMEN`, `AKSESORIS_HP`. Tiap template: 8–15 kategori contoh, tipe produk, metode bayar, 1 outlet, `store_profile` default, contoh produk (opsional).

**Provisioning idempotent**: `provisioning_jobs.step` dicek sebelum eksekusi → retry aman; kegagalan → `tenants.status=FAILED` + pesan; tidak ada DB yatim (drop di retry/rollback).

### 4.5 Connection routing

`middleware/tenant.ts` (dipakai hanya oleh `tenant_api.ts`):

1. **Resolve kode tenant**: subdomain `*.api.quotaku.com` → label pertama; jika tidak, `X-Tenant-Code`; jika tidak, `?tenant=`; jika tidak, `DEFAULT_TENANT_CODE` (tenant-1).
2. **Cache registry** ringan: `platform_db.tenants` di-cache 60 detik (invalidasi saat status/plan berubah) — atau DB lokal `.env` bila platform DB mati.
3. **Pool cache**: `Map<tenantCode, pg.Pool>` (max 5 koneksi, `idleTimeoutMillis=30s`, `statement_timeout=15s`; `max_connections` dicek). Miss → buat Pool baru. Error koneksi → evict + recreate.
4. **Auth**: JWT harus punya claim `tid` (kode tenant) & `tid_db`; jika `tid !== kode tenant hasil routing` → `403 TENANT_TOKEN_MISMATCH` (token bocor antar tenant ditolak).
5. **Entitlement**: `GET api.quotaku.com/api/v1/tenant/entitlements` (service key) cache 60 detik; fallback ke baris `tenant_entitlements` di DB tenant.
6. Error tenant tidak dikenal → `404 TENANT_NOT_FOUND`; suspended → `403 TENANT_SUSPENDED`.

**JWT**: `signToken` Claims ditambah `tid`, `tid_db`, `tcode`, `plan` (statis, tidak berubah sampai token refresh 12 jam; perubahan plan memaksa refresh cepat via `token_version` bila perlu).

### 4.6 Migrasi tenant existing (inventory_db → tenant #1)

| Skenario | Dampak | Keputusan |
|---|---|---|
| **0. Daftar sebagai tenant (paling minim)** | `tenants` row `code=acme`, `db_name=inventory_db`, `is_admin=true`, `is_grandfathered=true`, `plan_code=BUSINESS` (tanpa tagihan), `status=ACTIVE` | **Dipilih** |
| 1. Rename DB jadi `t_acme` | `ALTER DATABASE ... RENAME` butuh semua koneksi keluar; `ALTER DATABASE` butuh lock eksklusif; downtime | Tidak dilakukan (nama DB tidak penting karena selalu via `db_name`) |
| 2. Dump & restore ke `t_acme` | 5–15 menit downtime, risiko kehilangan data baru selama proses | Tidak (opsional, hanya bila butuh reset) |

Langkah rinci:

1. `pg_dump -Fc inventory_db` → verifikasi restore ke DB scratch (opsional tapi disarankan).
2. Seed `platform_db`: `tenants` (acme/inventory_db, jenis usaha dari data saat ini → `KONTER_PULSA`), `subscription` `GRANDFATHERED`/`BUSINESS`, `subscription_plans` (Trial/Basic/Pro/Business) bila belum ada.
3. Jalankan migration 0009 (outlet + entitlement) di `inventory_db` via `npm run migrate -- --all` (fan-out) → tenant #1 punya 1 outlet default = `store_profile` yang ada.
4. `DEFAULT_TENANT_CODE=acme` di `.env` → **FE & `server.ts` lama tidak berubah sama sekali** (41 path, JWT, test e2e tetap jalan).
5. Registrasi `acme.api.quotaku.com` (wildcard cert) → cek login, `/health`, `/reports/pnl`, e2e.
6. Dengan `is_admin=true`, akun internal distributor tidak punya tagihan; analytics tetap ikut teragregasi di ETL.

---

## 5. Skema DB Platform

Prinsip: platform_db **menyimpan data kendali & agregat**, tidak menyimpan transaksi mentah tenant (itu milik DB tenant). Semua query agregat masuk lewat ETL (§8).

### 5.1 `tenants` + `outlets`

```sql
CREATE TABLE tenants (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL UNIQUE,            -- slug pendek: 'acme', 'toko-budi' (a-z0-9-)
  name            text NOT NULL,
  business_type   text NOT NULL CHECK (business_type IN
    ('WARUNG_SEMBAKO','KONTER_PULSA','MINIMARKET','KOSMETIK','VITAMIN_SUPLEMEN','AKSESORIS_HP','LAINNYA')),
  is_admin        boolean NOT NULL DEFAULT false,   -- akun internal distributor (tenant-1)
  status          text NOT NULL DEFAULT 'PROVISIONING'
                  CHECK (status IN ('PROVISIONING','ACTIVE','SUSPENDED','EXPIRED','FAILED','DELETED')),
  plan_code       text REFERENCES subscription_plans(code),
  is_grandfathered boolean NOT NULL DEFAULT false,  -- tenant awal: fitur BUSINESS tanpa tagihan
  db_name         text NOT NULL UNIQUE,            -- 't_acme' / 'inventory_db'
  db_role         text NOT NULL,                   -- 't_acme' (login DB per tenant)
  subdomain       text UNIQUE,                     -- 'acme.api.quotaku.com'
  owner_name      text NOT NULL,
  owner_email     text,
  owner_phone     text,
  city            text, province text, address text, npwp text,
  trial_ends_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  activated_at    timestamptz,
  last_seen_at    timestamptz,                     -- heartbeat dari tenant API
  last_etl_at     timestamptz,                     -- checkpoint ETL per tenant
  etl_status      text DEFAULT 'PENDING' CHECK (etl_status IN ('PENDING','OK','ERROR')),
  etl_error       text,
  notes           text
);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_plan   ON tenants(plan_code);

CREATE TABLE outlets (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,               -- 'OUT-01'
  name        text NOT NULL,
  address     text, phone text, city text, province text,
  is_default  boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  opened_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
```

DB tenant (migration **0009**, applied per tenant):

```sql
CREATE TABLE outlet (
  id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code        varchar(30) NOT NULL DEFAULT 'OUT-01',
  name        varchar(150) NOT NULL,
  address     text, phone varchar(30), city text, province text,
  is_default  boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO outlet (code, name, is_default) VALUES ('OUT-01','Outlet Utama',true);

ALTER TABLE sales            ADD COLUMN outlet_id integer REFERENCES outlet(id);
ALTER TABLE purchases        ADD COLUMN outlet_id integer REFERENCES outlet(id);
ALTER TABLE stock_opnames    ADD COLUMN outlet_id integer REFERENCES outlet(id);
ALTER TABLE cash_sessions    ADD COLUMN outlet_id integer REFERENCES outlet(id);
ALTER TABLE user_account     ADD COLUMN outlet_id integer REFERENCES outlet(id);
-- backfill: semua data lama -> outlet utama
UPDATE sales         SET outlet_id = (SELECT id FROM outlet WHERE is_default) WHERE outlet_id IS NULL;
UPDATE purchases     SET outlet_id = (SELECT id FROM outlet WHERE is_default) WHERE outlet_id IS NULL;
UPDATE stock_opnames SET outlet_id = (SELECT id FROM outlet WHERE is_default) WHERE outlet_id IS NULL;
UPDATE cash_sessions SET outlet_id = (SELECT id FROM outlet WHERE is_default) WHERE outlet_id IS NULL;
-- default saat INSERT tanpa X-Outlet-Id: trigger BEFORE INSERT set ke outlet default tenant
```

> Catatan desain: `store_profile` (single row) **tetap ada** sebagai profil default struk; `outlet` menambah identitas multi-cabang. `POST /sales/{id}/receipt` membaca outlet (nama/alamat) bila ada, fallback `store_profile` → kompatibel dengan FE saat ini (`Receipt` dapat field `outlet` opsional di 3.0.0).

```sql
CREATE TABLE tenant_entitlements (         -- 1 baris per DB tenant; cache & fallback
  id                  integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tenant_code         text NOT NULL,
  plan_code           text NOT NULL,
  status              text NOT NULL CHECK (status IN
                        ('TRIAL','ACTIVE','PAST_DUE','EXPIRED','SUSPENDED','GRANDFATHERED')),
  max_outlets         integer NOT NULL,
  max_users           integer NOT NULL,
  features            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {feature: true, ...} §6
  trial_ends_at       timestamptz,
  current_period_end  timestamptz,
  token_version       integer NOT NULL DEFAULT 1,            -- naik saat plan berubah
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

### 5.2 `platform_users` + `platform_sessions`

```sql
CREATE TABLE platform_users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text NOT NULL,                 -- bcrypt
  role          text NOT NULL CHECK (role IN ('SUPERADMIN','OPS','VIEWER')),
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_sessions (                -- refresh token superadmin
  token_hash  text PRIMARY KEY, user_id bigint NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_tenant_keys (             -- akses program tenant API -> platform
  id bigserial PRIMARY KEY, tenant_code text NOT NULL UNIQUE,
  key_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
```

### 5.3 `subscription_plans`, `subscriptions`, `invoices`, `payment_intents`

```sql
CREATE TABLE subscription_plans (
  code          text PRIMARY KEY,              -- 'TRIAL','BASIC','PRO','BUSINESS'
  name          text NOT NULL,
  price_monthly numeric(12,2) NOT NULL DEFAULT 0,
  price_yearly  numeric(12,2) NOT NULL DEFAULT 0,   -- 10x bulanan (diskon 2 bulan)
  trial_days    integer NOT NULL DEFAULT 0,
  max_outlets   integer NOT NULL, max_users integer NOT NULL,
  features      jsonb NOT NULL DEFAULT '{}'::jsonb, -- kunci fitur §6.4
  limits        jsonb NOT NULL DEFAULT '{}'::jsonb, -- mis. {export_rows: 5000, wa_struk: 200}
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Seed: TRIAL(0/0/1out/2user/14hari) BASIC(99k/950k/1/3) PRO(249k/2.39jt/3/5) BUSINESS(499k/4.79jt/10/15)

CREATE TABLE subscriptions (
  id            bigserial PRIMARY KEY,
  tenant_id     bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code     text NOT NULL REFERENCES subscription_plans(code),
  status        text NOT NULL CHECK (status IN
                  ('TRIAL','ACTIVE','PAST_DUE','EXPIRED','CANCELED','SUSPENDED','GRANDFATHERED')),
  billing_cycle text NOT NULL DEFAULT 'MONTHLY' CHECK (billing_cycle IN ('MONTHLY','YEARLY','TRIAL')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end   timestamptz NOT NULL,
  auto_renew    boolean NOT NULL DEFAULT true,
  cancelled_at  timestamptz, cancel_reason text
);

CREATE TABLE invoices (
  id             bigserial PRIMARY KEY,
  tenant_id      bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id bigint REFERENCES subscriptions(id),
  invoice_no     text NOT NULL UNIQUE,            -- 'INV-2026-000123'
  period_start   date NOT NULL, period_end date NOT NULL,
  subtotal       numeric(12,2) NOT NULL,
  discount       numeric(12,2) NOT NULL DEFAULT 0,  -- diskon tahunan (2 bulan)
  total          numeric(12,2) NOT NULL,
  status         text NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PAID','OVERDUE','VOID')),
  due_date       date NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  payment_method text,                            -- 'BANK_TRANSFER'|'QRIS'
  payment_ref    text,                            -- bukti transfer/QRIS
  confirmed_by   bigint REFERENCES platform_users(id),
  notes          text
);

CREATE TABLE payment_intents (                     -- tracking proses pembayaran manual
  id bigserial PRIMARY KEY, tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id bigint REFERENCES invoices(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL, method text NOT NULL CHECK (method IN ('BANK_TRANSFER','QRIS')),
  reference text, proof_note text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, confirmed_by bigint REFERENCES platform_users(id)
);
```

### 5.4 Agregat analitik

```sql
CREATE TABLE usage_daily (                          -- 1 baris per tenant per hari (inti dashboard)
  tenant_id    bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id    bigint NOT NULL DEFAULT 0,           -- 0 = digabung semua outlet (bukan NULL: PK tak boleh NULL)
  biz_date     date NOT NULL,
  trx_count    integer NOT NULL DEFAULT 0,
  gross_sales  numeric(14,2) NOT NULL DEFAULT 0,    -- omzet COMPLETED, is_test=false
  discount     numeric(14,2) NOT NULL DEFAULT 0,
  tax_total    numeric(14,2) NOT NULL DEFAULT 0,
  cogs         numeric(14,2) NOT NULL DEFAULT 0,
  refund_total numeric(14,2) NOT NULL DEFAULT 0,
  gross_profit numeric(14,2) NOT NULL DEFAULT 0,    -- gross_sales - cogs - refund
  item_qty     numeric(14,3) NOT NULL DEFAULT 0,
  new_products integer NOT NULL DEFAULT 0,
  active_users integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, outlet_id, biz_date)
);
CREATE INDEX idx_usage_daily_date ON usage_daily(biz_date);

CREATE TABLE tenant_product_sales_daily (          -- detail produk, 1 baris/tenant/produk/hari
  tenant_id   bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id   bigint NOT NULL DEFAULT 0,           -- 0 = digabung semua outlet
  biz_date    date NOT NULL,
  product_id  bigint NOT NULL,                     -- id lokal di DB tenant
  product_key text NOT NULL,                       -- normalisasi nama (lowercase, tanpa simbol)
  product_name text NOT NULL,                      -- nama asli (free-text)
  category_tenant text,                            -- kategori versi tenant (bisa free-text)
  platform_category text,                          -- hasil normalisasi taksonomi
  qty_sold    numeric(14,3) NOT NULL DEFAULT 0,
  gross_sales numeric(14,2) NOT NULL DEFAULT 0,
  cogs        numeric(14,2) NOT NULL DEFAULT 0,
  trx_count   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, outlet_id, product_id, biz_date)
);
CREATE INDEX idx_prod_sales_key ON tenant_product_sales_daily(product_key, biz_date);
```

Taksonomi & normalisasi:

```sql
CREATE TABLE platform_categories (                 -- taksonomi distributor (hierarki 2 tingkat)
  id        serial PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL,
  parent_code text,                                 -- mis. 'PAKET_DATA' -> 'PULSA'
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE tenant_category_map (                 -- hasil kurasi manual: kategori tenant -> platform
  tenant_id bigint NOT NULL, category_tenant text NOT NULL, platform_category text NOT NULL,
  mapped_by bigint REFERENCES platform_users(id), mapped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, category_tenant)
);
CREATE TABLE etl_category_rules (                  -- auto-mapping keyword (tier 2 §8.4)
  id serial PRIMARY KEY, platform_category text NOT NULL, pattern text NOT NULL, priority integer NOT NULL DEFAULT 100
);
```

### 5.5 Operasional & audit

```sql
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, actor_type text NOT NULL CHECK (actor_type IN ('SUPERADMIN','TENANT','SYSTEM')),
  actor_id text, tenant_id bigint REFERENCES tenants(id) ON DELETE SET NULL,
  action text NOT NULL,                            -- 'TENANT_SUSPEND','PLAN_CHANGE','PAYMENT_CONFIRM','EXPORT_CSV',...
  target_type text, target_id text, ip inet, user_agent text,
  meta jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);

CREATE TABLE tenant_provisioning_jobs (           -- checkpoint provisioning (idempotent)
  id bigserial PRIMARY KEY, tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  step text NOT NULL, status text NOT NULL CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  error text, started_at timestamptz, finished_at timestamptz
);
CREATE TABLE job_runs (                            -- log ETL & job platform
  id bigserial PRIMARY KEY, job_name text NOT NULL, tenant_id bigint,
  status text NOT NULL CHECK (status IN ('RUNNING','OK','ERROR')),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, detail jsonb
);
CREATE TABLE platform_settings (key text PRIMARY KEY, value jsonb, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE notifications (                       -- log WA/email ke owner tenant
  id bigserial PRIMARY KEY, tenant_id bigint REFERENCES tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('WA','EMAIL')), kind text NOT NULL,   -- TRIAL_ENDING, INVOICE_DUE, SUSPENDED
  target text, body text, status text NOT NULL DEFAULT 'SENT', sent_at timestamptz NOT NULL DEFAULT now()
);
```

---

## 6. Matriks Langganan

### 6.1 Harga

| Plan | Bulanan | Tahunan (diskon 2 bulan ≈ −16,7%) | Outlet | User | Tagihan min. |
|---|---|---|---|---|---|
| **Trial** | Rp0 | — (tidak dijual) | 1 | 2 | — |
| **Basic** | Rp99.000 | Rp950.000 (≈10 bulan) | 1 | 3 | — |
| **Pro** | Rp249.000 | Rp2.390.000 | ≤3 | ≤5 | — |
| **Business** | Rp499.000 | Rp4.790.000 | ≤10 | ≤15 | — |

Justifikasi harga (lihat §7): omzet warung mikro rata-rata Rp3–15 juta/bulan ⇒ langganan = 0,7–3% omzet; posisi harga di rentang kompetitor POS lokal (umumnya Rp50–200rb/outlet/bulan + biaya device) tapi **free multi-outlet, struk WA, dan retur distributor** sebagai pembeda. Margin tetap sehat karena ada margin barang ke tenant.

### 6.2 Fitur per plan

| Fitur | Trial | Basic | Pro | Business | Kunci flag (`features`) |
|---|---|---|---|---|---|
| POS, master produk, batch, harga beli/jual, PPN, satuan ALT | ✅ | ✅ | ✅ | ✅ | `core.pos` |
| Struk cetak (BT 58/80mm), re-print | ✅ | ✅ | ✅ | ✅ | `receipt.print` |
| Pembayaran partial/multi metode, kasbon & piutang, cash session | ✅ | ✅ | ✅ | ✅ | `core.payments` |
| Stok rusak, void berlabel, refund parsial, opname harian | ✅ | ✅ | ✅ | ✅ | `core.opname` |
| **Retur distributor** (stok rusak → supplier, P&L `refund_distributor`) | ✅ | ✅ | ✅ | ✅ | `core.supplier_return` |
| Dashboard penjualan, stok, alerts | ✅ | ✅ | ✅ | ✅ | `reports.basic` |
| **Multi-outlet** (limit plan) | ❌ (1) | ❌ (1) | ✅ (≤3) | ✅ (≤10) | `outlet.multi` |
| **Multi-user** (limit plan) | 2 | 3 | 5 | 15 | (limit angka, bukan flag) |
| **P&L / laba bersih** (`/reports/pnl`) | ❌ | ❌ | ✅ | ✅ | `reports.pnl` |
| **Laporan opname lanjutan** (per cause, tren 6 bulan, top 10) | ❌ | ❌ | ✅ | ✅ | `reports.opname` |
| **Export CSV** (transaksi, produk, stok; ≤5.000 baris/hari) | ❌ | ❌ | ✅ | ✅ | `export.csv` |
| **Akses API publik** (API key tenant + rate limit) | ❌ | ❌ | ❌ | ❌ *(backlog — belum ada API publik; flag `api.public` disiapkan tapi belum dijual)* | `api.public` |
| **Prioritas SLA 4 jam + onboarding berkala** | ❌ | ❌ | ❌ | ✅ | `support.priority` |
| **Support** | WhatsApp 2×/minggu | WhatsApp hari kerja | WhatsApp 08.00–20.00 | **Prioritas** SLA 4 jam kerja 08.00–18.00 | `support.priority` |
| **Diskon produk distributor** (katalog harga grosir B2B) | ❌ | ❌ | ✅ (5%) | ✅ (10%) | `catalog.discount` |
| Retention backup | 7 hari | 14 hari | 30 hari | 90 hari + restore on-demand | (setting backup) |
| Struk tanpa brand Mayan POS (white-label penuh) | ❌ | ❌ | ✅ | ✅ | `branding.whitelabel` |
| Status langganan & tagihan di app (informasi) | ✅ | ✅ | ✅ | ✅ | (UI saja) |

### 6.3 Enforcement

- `resolveTenant` → `entitlement middleware` memanggil `GET /api/v1/tenant/entitlements` (platform, service key, cache 60 detik, fallback baris `tenant_entitlements`).
- Guard per endpoint: `requireFeature('reports.pnl')` → `403 FEATURE_NOT_AVAILABLE {feature, required:['PRO','BUSINESS'], upsell_url}`.
- Guard jumlah: `outlets/users` → `402 PLAN_LIMIT_REACHED {feature:'outlets', limit, current, upsell_url}`.
- Status `EXPIRED`/`SUSPENDED` → mutasi diblok `402 SUBSCRIPTION_REQUIRED`; **baca tetap boleh** (read-only, agar data tidak "hilang" bagi kasir).
- FE memetakan kode baru ini ke dialog upsell (lihat §9 tabel, item 4d).
- Owner PLAN/TRIAL/EXPIRED masih boleh `/reports/*` (read-only) supaya bisa lihat P&L untuk memutuskan bayar.

### 6.4 Kontrak `features` (JSON per plan)

```jsonc
// BASIC
{ "core.pos": true, "receipt.print": true, "core.payments": true,
  "core.opname_supplier_return": true, "reports.basic": true,
  "outlet.multi": false, "reports.pnl": false, "reports.opname": false,
  "export.csv": false, "api.public": false, "support.priority": false,
  "catalog.discount": false, "branding.whitelabel": false }
// PRO: reports.pnl/opname/export.csv/outlet.multi/catalog.discount/branding.whitelabel = true
// BUSINESS: semua true KECUALI api.public (backlog — belum dijual, default false)
```

---

## 7. Insight Bisnis Langganan

### 7.1 Pasar mikro-ritel Indonesia

- **Ukuran pasar**: UMKM ≈ 65 juta (2023–2024), IMSME ≈ 66–68 juta; **mayoritas belum memakai POS** (pemakaian POS awan <10%). Pasar ini besar justru karena belum digital, bukan karena sudah ada yang pakai.
- **Segmen yang cocok dengan 6 template**: warung Sembako, konter pulsa, minimarket, kosmetik, vitamin, aksesoris HP. Karakter produk yang cocok: konter pulsa/voucher (nilai tinggi/margin tebal, TKDN wajib), minimarket/sembako (volume, stok opname harian), kosmetik & vitamin (trend naik, expiry!), aksesoris HP (SKU cepat, harga fluktuatif).
- **Sensitifitas harga tinggi**: pemilik warung rutin membandingkan tagihan per bulan dan enggan terikat kontrak panjang. Karena itu langganan dijaga <1% omzet, dan **bulanan** lebih mudah diterima; tahunan untuk retensi (dengan diskon).
- **Non-teknis**: pemilik warung belum terbiasa dengan setup teknis; onboarding harus <10 menit, template data siap pakai, dan semua istilah dalam bahasa Indonesia sederhana.
- **Distribusi**: akuisisi lewat jaringan agen & toko yang sudah ada; pemilik platform adalah distributor sehingga jalur ini murah dan sudah teruji.

### 7.2 Positioning vs kompetitor POS lokal

| | Kompetitor POS lokal (umum) | Mayan POS |
|---|---|---|
| Harga | Rp50–200rb/outlet/bulan + device | Rp99rb (1 outlet) sampai Rp499rb (10 outlet), **tanpa biaya device** |
| Fokus | Penjualan + stok | Penjualan + stok + **opname analytics** + **retur distributor** (karantina → supplier) |
| Multi-cabang | Umumnya terbatas | Tabel outlet dalam satu DB + rekap terpusat di console |
| Struk | cetak thermal | thermal + **kirim struk via WhatsApp** (beda besar di pasar ini) |
| Support | chat/email jam kerja | WhatsApp + prioritas SLA (Business) |
| Distribusi barang | tidak ada | **terhubung distributor**: katalog, harga grosir, retur, bundling |

**Positioning yang dipilih**: "POS murah yang sudah terhubung ke distributor." Nilai yang dijual bukan software, tapi **barang + arus kas stok**. Inilah yang membuat churn rendah dan ARPU tinggi di tier atas.

### 7.3 Model pendapatan (3 pilar + upsell)

| Pilar | Alur pendapatan | Kontribusi (target) | Catatan |
|---|---|---|---|
| **1. Langganan SaaS** | Rp99–499rb/bulan per tenant | 30–40% dari revenue | MRR, churn <3%/bulan; bayar tahunan (2 bulan gratis) → cash flow di muka |
| **2. Margin distributor** | jual kartu/voucher/kosmetik/vitamin/sembako ke tenant | 50–60% | Sifatnya "lengket" (tenant yang sudah rutin beli dari platform sulit pindah); naik bersama pertumbuhan tenant |
| **3. Upsell & layanan tambahan** | struk WA (Rp30–50rb/bulan), outlet tambahan, API, brand premium | 5–10% | Struk WA = pendapatan berulang (bukan sekadar fitur); butuh WA Business API (fase lanjut) |
| Bundling (cross-sell) | kredit pembelian + potongan langganan | retensi | Contoh: "Potongan langganan untuk belanja di atas Rp5 juta/bulan" |

### 7.4 Metrik kunci (dashboard superadmin & review bulanan)

| Kategori | Metrik | Target 12 bulan pertama (hipotesis, dapat direvisi) |
|---|---|---|
| **MRR & pertumbuhan** | MRR, MRR baru, MRR ekspansi (upgrade), MRR churn, retensi pendapatan bersih (NRR) | MRR Rp60 juta; NRR ≥110% |
| **Aktivasi** | **Transaksi pertama <24 jam** setelah aktivasi (definisi utama), % tenant aktif mingguan | ≥60% tenant trial melakukan transaksi pada 24 jam pertama |
| **Trial → bayar** | Tingkat konversi trial→bayar (14 hari), median waktu konversi | ≥25% |
| **Retensi** | Churn logo & pendapatan bulanan, retensi kohort (M1/M3/M6) | churn ≤3% |
| **Engagement** | Transaksi/tenant/hari, hari aktif per bulan, produk aktif/outlet | ≥60% tenant aktif setiap minggu |
| **Kualitas** | Error 5xx per 1.000 request, uptime, waktu provisioning (target <60 detik) | uptime 99,5%; provisioning <60 detik |
| **Finansial** | Invoice belum dibayar, umur piutang (target ≤7 hari), ARPU, LTV (≈ARPU × rata-rata umur) | ARPU Rp150rb; DSO ≤7 hari |
| **Analitik & riset** | % produk terkurasi, jumlah kategori ter-normalisasi, sinyal restock | ≥70% penjualan terpetakan kategori platform |

### 7.5 Strategi trial → bayar

1. **Wizard 4 langkah** di web (jenis usaha → data toko/owner → pilih plan → mulai trial 14 hari), <5 menit, tanpa minta kartu kredit.
2. **Aktivasi cepat lewat template**: kategori/produk contoh sudah terisi ⇒ transaksi pertama bisa terjadi <24 jam.
3. **Nudge WA**: hari ke-3 ("toko belum transaksi, mau dibantu?"), hari ke-10 (info plan Pro), hari ke-13 (tagihan & fitur Pro).
4. **Batas akhir yang jelas**: trial habis → mode read-only + banner di FE (data tidak hilang) → tawaran upgrade terlihat jelas.
5. **Promo awal**: "Basic 2 bulan pertama Rp79rb" atau diskon tahunan, kode single-use.
6. **Social proof lokal**: studi kasus per jenis usaha (memakai data agregat, tanpa menyebut nama tenant).

### 7.6 Bundling produk distributor ke tenant

- **Katalog di app** (fase lanjut): tenant melihat harga grosir + "beli dari distributor" via PO sederhana; pembayaran transfer/kredit.
- **Bundling insentif**: tenant aktif ≥3 bulan dengan belanja di atas ambang tertentu mendapat potongan langganan atau gratis upgrade Pro → margin barang naik, SaaS jadi insentif.
- **Kredit & tempo bayar** hanya untuk Business (limit, siklus tagih 30 hari) → mengikat tenant pada distributor (retensi), tetapi perlu kontrol piutang (P&L/aging) yang baru dibangun sampai fase SAAS-6.
- **Prediksi restock**: agregat permintaan lintas tenant (§8) → saran katalog otomatis per tenant ("produk X laris 40 toko di sekitarmu").

---

## 8. Analisa Market Distributor (ETL + Dashboard)

### 8.1 Prinsip

1. **Read-only**: job platform **hanya SELECT** ke DB tenant (role DB `etl_ro`), dengan `statement_timeout` pendek.
2. **Tanpa PII**: yang diambil = id produk, nama produk, kategori, qty, omzet, HPP. Tidak ada nama pelanggan/kasir.
3. **Harian (T+1)**: snapshot per hari, append-only per tanggal (bisa di-backfill). Jam 01:15 Asia/Jakarta setelah tutup buku.
4. **Idempotent**: `UPSERT` per (tenant, outlet, tanggal, produk) + `job_runs` untuk audit; aman diulang.
5. **Checkpoint per tenant**: `tenants.last_etl_at` + `etl_status`; satu tenant gagal tidak menghalangi yang lain.

### 8.2 Pipeline

```
cron 01:15 WIB  →  platform/jobs/etl-omzet.ts  (--tenant=<kode> opsional, default semua ACTIVE)
   loop tenant (platform_db.tenants, status='ACTIVE' dan belum DELETED):
     1. connect read-only ke db_name (statement_timeout=30s)
     2. EXTRACT  ─ SQL agregat HARI INI (timezone Asia/Jakarta, status='COMPLETED', is_test=false)
          · omzet   : SUM(sale_items.subtotal) + SUM(sales.tax_amount)
          · HPP     : SUM(sale_items.qty * sale_items.unit_cost)
          · refund  : SUM(refunds.amount) per refunded_at
          · produk  : sale_items.qty per product (product_key normalisasi nama)
          · user    : COUNT(DISTINCT sales.created_by) ; produk baru: COUNT(DISTINCT product.id)
     3. TRANSFORM ─ normalisasi kategori (§8.4) & product_key (§8.3)
     4. LOAD     ─ UPSERT platform_db.usage_daily & tenant_product_sales_daily
     5. update tenants.last_etl_at, etl_status='OK'; catat job_runs
   ringkasan: log "N tenant sukses, M gagal" (+ alert bila M>0)
```

Contoh SQL agregat per tenant (intinya, kolom existing):

```sql
-- omzet per hari (COMPLETED, bukan data uji, TZ Asia/Jakarta)
SELECT (s.sale_date AT TIME ZONE 'Asia/Jakarta')::date AS biz_date,
       COUNT(DISTINCT s.id)                AS trx_count,
       COALESCE(SUM(si.subtotal),0)         AS gross_sales,
       COALESCE(SUM(s.tax_amount),0)        AS tax_total,
       COALESCE(SUM(si.qty * si.unit_cost),0) AS cogs,
       COALESCE(SUM(si.qty),0)              AS item_qty,
       COUNT(DISTINCT s.created_by)         AS active_users
  FROM sales s
  JOIN sale_items si ON si.sale_id = s.id
 WHERE s.status = 'COMPLETED' AND s.is_test = false
   AND (s.sale_date AT TIME ZONE 'Asia/Jakarta')::date = CURRENT_DATE
 GROUP BY 1;

-- produk per hari (untuk riset katalog)
SELECT si.product_id, p.name AS product_name, COALESCE(c.name,'Tanpa Kategori') AS category_tenant,
       SUM(si.qty) AS qty_sold, SUM(si.subtotal) AS gross_sales, SUM(si.qty*si.unit_cost) AS cogs
  FROM sale_items si
  JOIN sales   s ON s.id = si.sale_id
  JOIN product p ON p.id = si.product_id
  LEFT JOIN product_category c ON c.id = p.category_id
 WHERE s.status = 'COMPLETED' AND s.is_test = false
   AND (s.sale_date AT TIME ZONE 'Asia/Jakarta')::date = CURRENT_DATE
 GROUP BY si.product_id, p.name, c.name;
```

### 8.3 Normalisasi produk (`product_key`)

Nama produk tenant = free-text ("Indomie Goreng 85g", "Indomie Mi Goreng", "IM GORENG"). Kunci agregat lintas tenant:

```
product_key = lower(trim(regexp_replace(nama, '[^a-zA-Z0-9]+', ' ', 'g')))
             THEN ambil 2-3 token inti (buang ukuran/merk bila cocok kamus)
```

Di platform: `product_key` disimpan di tabel agregat sehingga **produk yang sama antar tenant** otomatis teragregasi; console menampilkan grup (contoh: "Indomie Goreng" = 1 grup dari 6 tenant). tetap bisa ditelusuri ke nama asli per tenant (traceability) tanpa mengekspos PII.

### 8.4 Normalisasi kategori lintas tenant (3 tier)

| Tier | Cara | Contoh |
|---|---|---|
| 1. **Mapping kurasi** | `tenant_category_map` diisi manual di console (per tenant) | kategori tenant "KULKAS" → platform `KULKAS_BEKU` |
| 2. **Auto by keyword** | `etl_category_rules` (regex contain) | `/pulsa|kuota|data|token/` → `PULSA`; `/sambal|beras|gula|minyak/` → `SEMBAKO`; `/serum|toner|cream|shampoo/` → `KOSMETIK`; `/vitamin|suplemen|kalsium/` → `VITAMIN` |
| 3. **Default** | taksonomi platform | `LAINNYA` + masuk daftar "perlu dikurasi" di dashboard |

Taksonomi platform awal (parent → child): `PULSA` (PULSA_REGULER, PAKET_DATA, PAKET_NOWATSU, VOUCHER), `PERAWATAN` (KOSMETIK, SKINCARE, VITAMIN), `ELEKTRONIK` (AKSESORIS_HP, HANDPHONE, KABEL), `PANGKAL` (SEMBAKO, MINUMAN, ROKOK, RUMAH_TANGGA, LAINNYA). Dashboard menampilkan **coverage** (% baris agregat yang ter-mapping) & form kurasi.

### 8.5 Dashboard superadmin (halaman `Analytics`)

| Metrik / grafik | Sumber | Untuk apa |
|---|---|---|
| **Omzet platform** harian/bulanan (garis), MRR (garis kedua) | `usage_daily` + `subscriptions` | kesehatan bisnis |
| **Omzet per jenis usaha** (bar) | `usage_daily` + `tenants.business_type` | segmentasi pasar |
| **Ranking tenant** omzet (tabel, sort, filter periode & jenis) | `usage_daily` | performa & sinyal churn |
| **Omzet per tenant** (sparkline mini) | `usage_daily` | preview di list tenant |
| **Tren 30 hari** omzet (garis/area) | `usage_daily` | musiman (mis. Ramadan, 9-12) |
| **Top produk lintas tenant** (tabel: produk_key, jumlah tenant, qty, omzet, HPP, margin%) | `tenant_product_sales_daily` | riset pembelian |
| **Top kategori platform** (donat/bar + coverage %) | agregat + `platform_categories` | komposisi produk |
| **Produk muncul baru** (baru 30 hari, naik di ≥3 tenant) | agregat | menangkap permintaan baru |
| **Health score per tenant** (trx/hari, hari aktif, produk aktif, status langganan) | `usage_daily` + `tenants` | scrum & pendekatan commercial |
| **Kurasi kategori** (kategori tenant → platform, form) | `tenant_category_map` | kualitas data |
| **Job ETL** (terakhir, sukses/gagal per tenant) | `job_runs`, `tenants.etl_status` | keandalan pipeline |

### 8.6 Ekspor riset (CSV)

Template ekspor (dipilih per filter: periode, jenis usaha, kategori, tenant):

```
periode, jenis_usaha, platform_category, product_key, product_name_contoh,
jumlah_tenant, qty_total, omzet_total, hpp_total, margin_pct, tenant_teratas
```

Dipakai distributor untuk: menentukan produk apa yang perlu distok, ke berapa tenant(unique), musiman berapa, dan margin mana yang layak. Ekspor dicatat di `audit_log`.

### 8.7 Privasi & data

- Tidak ada PII di agregat; nama produk/tenant internal saja (bukan untuk dipublikasikan tanpa izin).
- Retensi: `tenant_product_sales_daily` 24 bulan, `usage_daily` 36 bulan (lalu agregasi tahunan).
- Tiap tenant punya **dashboard "data saya"** (nama produk apa yang sudah diambil ETL) untuk transparansi.
- Ekspor di luar tenant scope harus dicatat; satu tenant tidak boleh melihat agregat tenant lain lewat API publik (`api.public` hanya untuk data tenant itu sendiri).

---

## 9. Perubahan Aplikasi Flutter

> **Jawaban eksplisit (point 10): YA — ada perubahan pada aplikasi Flutter.** Yang berubah: konfigurasi koneksi (tenant-aware), tambahan layar (status langganan, switcher outlet, upsell). Yang **tidak** berubah: seluruh 41 path API, logika POS/cart/RBAC KASIR-OWNER, struk BT, design system, dan `menu-matrix.md`.

Estimasi total **±13 hari kerja** (FE-4a…FE-4f), sebagian bisa paralel dengan fase backend.

| # | Perubahan | Target file FE | Detail | Est. |
|---|---|---|---|---|
| **4a** | **Tenant resolver** (ganti base URL statis) | `lib/core/config/env.dart` (refr), baru `lib/core/tenant/tenant_resolver.dart`, `providers/api.dart`, `features/auth/login_screen.dart` | `--dart-define=API_BASE_URL` tetap honored sebagai **fallback** (dev/single-tenant). Field baru di login: "Kode toko" (dari subdomain/URL tenant, mis. `toko-budi` dari `toko-budi.api.quotaku.com`) → resolver memetakan ke base URL + `X-Tenant-Code` + `tid` valid. Login request: header `X-Tenant-Code`, body login tetap username/password. Error `TENANT_NOT_FOUND` → pesan "Kode toko tidak ditemukan / cek dengan penjual". Test: unit resolver (7 varian input), widget test login, `flutter test` hijau. | 2,0 d |
| **4b** | **Onboarding link ke web registrasi** | `features/auth/login_screen.dart` | Tombol "Belum punya akun? Daftar" → `url_launcher` membuka `https://www.quotaku.com/daftar` (bisa deep link `quotaku://daftar?ref=<kode>efef` dari QR). Tidak ada input registrasi di app. | 0,5 d |
| **4c** | **Switcher outlet + header `X-Outlet-Id`** | baru `providers/outlets.dart`, `api/outlet_api.dart`, `models/outlet.dart`, `features/shell/app_shell.dart` (header dropdown), `features/settings/outlets_section.dart` (kelola outlet) | `GET /outlets` saat login; simpan outlet aktif (persist); header `X-Outlet-Id` dikirim di semua request (via interceptor `dio_client.dart`); ganti outlet = pilih dari header (nama + kota), disembunyikan bila `outlet.multi=false` (1 outlet). | 3,0 d |
| **4d** | **UX limit plan (upsell)** | baru `features/upsell/upsell_sheet.dart`, `providers/entitlement.dart`, `core/utils/…` (mapping error) | Intercept `402 PLAN_LIMIT_REACHED` / `403 FEATURE_NOT_AVAILABLE` → **upsell sheet**: "Tambah outlet butuh plan Pro", tombol "Upgrade" (buka web/ WhatsApp sales) + "Nanti dulu". Tombol "Tambah Outlet" di Settings disembunyikan/di-guard bila limit tercapai. Copy Bahasa Indonesia, harga dari `/me` (plan & limit). | 2,0 d |
| **4e** | **Status langganan & tagihan (app OWNER)** | baru `features/owner/subscription_page.dart`, `api/subscription_api.dart`, badge di `features/owner/dashboard_page.dart` | `GET /subscription` → plan, status (TRIAL/ACTIVE/EXPIRED), masa aktif, trial tersisa, **tagihan aktif** (nomor, jumlah, jatuh tempo, tombol "Lihat cara bayar" = rekening/QRIS + upload bukti), riwayat 3 tagihan. Badge "Trial 5 hari lagi" di dashboard owner. Menu OWNER saja (RBAC). | 2,5 d |
| **4f** | **Read-only / force-logout saat expired** | `providers/auth.dart`, `features/shell/app_shell.dart`, `router/route_guard.dart`, `features/pos/pos_page.dart` | `GET /me` mengembalikan blok `subscription` (plan/status/period_end). `EXPIRED`/`PAST_DUE` → **mode read-only**: banner oranye di shell, tombol "Bayar/Upgrade", mutasi (jual, void, opname) dinonaktifkan dengan tooltip, baca & cetak struk tetap boleh. `SUSPENDED` (≥7 hari lewat) → **force logout** ke layar login dengan pesan. Token `token_version` naik saat status berubah → refresh otomatis. | 3,0 d |
| **—** | **Regresi & dokumentasi** | test FE + `fe/README.md` | Semua test existing tetap hijau; tambah test entitlement/upsell/outlet; update `fe/README.md` & `menu-matrix.md` (menu owner += "Langganan"). | 1,0 d |
| | | | **TOTAL SAAS-4** | **±13 d** |

**Endpoint tenant API baru yang dibutuhkan FE** (versi 3.0.0): `GET /me` (blok `tenant` + `subscription` + `entitlements`), `GET /outlets`, `POST /outlets` (limit), `PATCH /outlets/{id}`, `POST /outlets/{id}/activate`, `GET /subscription` (tagihan). Semua **GET** terbuka kedua role; mutasi outlet = OWNER.

---

## 10. Fase Implementasi

| Fase | Scope | Deliverable | Acceptance | Est. | Dependensi |
|---|---|---|---|---|---|
| **SAAS-0** Fondasi platform | DB platform, auth superadmin, tenant registry, skeleton `platform/` | `platform_db` migration (tables §5), `platform/` Express :4001, JWT superadmin, registry tenant, `tenant_api.ts` + middleware tenant, health | `npm run migrate -- --all` idempotent; `inventory_db` terdaftar jadi tenant #1; login superadmin JWT + RBAC; `X-Tenant-Code: acme` → `/auth/login` tetap 200 seperti lama; CORS allowlist aktif | 5 d | — |
| **SAAS-1** Registrasi + provisioning | Wizard web, endpoint registrasi, clone DB, seed master, subdomain | `POST /platform/registrations` (publik) + job provisioning, 6 template jenis usaha, halaman `/daftar` (SvelteKit), status/progress, trial auto-aktivasi | Daftar 1 tenant baru end-to-end: DB ter-clone <60 dtk, 1 akun OWNER, routing `X-Tenant-Code` live (subdomain wildcard DITUNDA — kode toko di login Flutter), transaksi pertama berhasil via FE; retry provisioning idempotent; tenant #1 tak terganggu | 7 d | SAAS-0 |
| **SAAS-2** Plan & limit | Enforcement plan/entitlement di tenant API, `outlet` + `X-Outlet-Id`, billing scheduler | Migration **0009** (outlet + entitlement) fan-out, `requireFeature`/limit middleware, `GET /me`+`outlets`+`subscription`, status EXPIRED (read-only) & SUSPENDED (blok), scheduler PAST_DUE/EXPIRED, kode error 402/403 baru, openapi 3.0.0 | Basic: outlet ke-2 → `402 PLAN_LIMIT_REACHED`; P&L di Basic → `403 FEATURE_NOT_AVAILABLE`; Pro: outlet ke-3 & P&L OK; trial habis → mutasi blok, baca OK; 41 path lama regression OK | 6 d | SAAS-0,1 |
| **SAAS-3** ETL & dashboard omzet | Job ETL harian, agregat usage + produk, dashboard superadmin | `platform/jobs/etl-omzet.ts`, `usage_daily`+`tenant_product_sales_daily` (+backfill 30 hari), normalisasi kategori/produk, halaman Analytics (omzet per tenant/outlet/jenis, ranking, tren, health score) | ETL idempotent (jalan 2× hasil sama), backfill 30 hari cocok dengan `/reports/pnl` tenant (toleransi <1%), dashboard terisi ≤24 jam, kategori ter-mapping >80% | 7 d | SAAS-0,1 |
| **SAAS-4** Perubahan Flutter | 4a–4f + regresi | Tenant resolver, upsell, switcher outlet, layar langganan owner, read-only/force-logout | FE build & 400+ test hijau; 2 tenant (Basic & Pro) login di app & limit enforced sesuai matrix; trial→expired di app → read-only; upgrade via web → app lanjut normal | 13 d | SAAS-2 (kontrak API) |
| **SAAS-5** Billing manual | Invoice transfer + konfirmasi manual (belum payment gateway) | invoice terbit otomatis + **kode pembayaran unik** (format `MYN-####-XX`) → tombol "Kirim via WhatsApp" (template pesan, admin kirim manual) → unggah bukti → `POST /platform/payments/:id/confirm` (periode diperpanjang), halaman Invoices, **scheduler dunning H+1/H+30/H+60** (peringatan dashboard superadmin + notifikasi tenant, lihat §12 #10) | Invoice terbit tiap periode; konfirmasi → subscription ACTIVE & periodepanjang; bukti tersimpan; semua tercatat di `audit_log` | 4 d | SAAS-2,3 |
| **SAAS-6** Insight distributor lanjutan | Kurasi kategori, riset produk, ekspor CSV, upsell WA struk | Form kurasi kategori, halaman Product-Market, ekspor CSV (6 template), bundling katalog sederhana, notifikasi WA (WAha Business API atau semi-manual) | Ekspor CSV berisi kolom §8.6 & sesuai filter; katalog "produk laris lintas tenant" tampil; notifikasi tagihan terkirim; uji 1 siklus invoice→konfirmasi | 5 d | SAAS-3,5 |
| **SAAS-7** Hardening | Audit, rate-limit per tenant, backup per tenant, monitoring, GDPR/data export | `audit_log` penuh + UI, rate limit per tenant, `backup.sh` loop per DB (retensi per plan), Uptime/health alert, `tenant_data_export`, runbook, load test 2 tenant | Rate limit tenant terpisah; backup tiap tenant otomatis & restore teruji; audit ACTION lengkap; load test 2 tenant 2 POS tanpa regresi; runbook go-live | 5 d | SAAS-2,3,5 |

**Total estimasi: ±52 hari kerja** (SAAS-0..7). Dengan 1 dev berurutan ≈ 11 minggu; sebagian paralel (FE SAAS-4 saat SAAS-3 jalan) ≈ 9–10 minggu.

---

## 11. Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| **Isolasi data** (tenant A bisa akses data tenant B) | Kritikal (kebocoran data antar pelanggan) | 1 DB/tenant (bukan `tenant_id`); JWT punya `tid` & dicek cocok routing (`TENANT_TOKEN_MISMATCH`); pool cache terisolasi per kode; test otomatis silang-tenant (QA-001: token tenant A ke host tenant B → 403) |
| **Koneksi DB habis** (N tenant × pool) | Outage saat banyak tenant aktif | Pool max 5 + idle 30 dtk + cache LRU; monitor `pg_stat_activity`; threshold alert >70% `max_connections`; PgBouncer (transaction mode) saat >100 tenant |
| **Biaya/kapasitas** (1 DB per tenant) | Lambat saat 500+ tenant | ±10–25 MB kosong + data; 200 tenant ≈ 3–5 GB (relatif murah di managed PG); **skala**: tambah cluster per ±300 tenant tanpa ubah kode aplikasi |
| **Migrasi tenant existing (inventory_db)** | Gangguan pada data/produksi | Daftar apa adanya (tanpa copy) + `is_admin`/`GRANDFATHERED`; `DEFAULT_TENANT_CODE` menjaga `server.ts` lama 100% jalan; backup penuh sebelum langkah apa pun |
| **Regresi 41 path** (middleware tenant, migration 0009) | Fitur existing rusak | `server.ts` lama tetap default; `npm run e2e` (245 PASS) & `npm run concurrency` (18/18) jadi gate tiap fase; 0009 forward-only + nullable + backfill |
| **Kepatuhan data (UU PDP)** | Risiko hukum | PII tidak masuk platform_db/ETL; agregat tanpa identitas; retensi & hapus per tenant (`DELETED` → drop DB) & ekspor data; DPA/ToS; akses `audit_log` tercatat |
| **Kategori produk free-text** (kualitas analitik) | Dashboard kacau | 3-tier mapping (§8.4) + halaman kurasi + metrik coverage; default `LAINNYA` = transparan, bukan data hilang |
| **Penyalahgunaan trial** (daftar lalu batal) | Unit economics | Rate limit registrasi/IP, verifikasi email/HP, 1 percobaan/HP, masa trial pendek, monitoring lonjakan registrasi |
| **Konsistensi fitur FE↔BE** (limit/flag tidak sinkron) | Keluhan pengguna | Kontrak `features` json = SSOT; `/me` kirim entitlements ke FE; test kontrak (Basic/Pro/Business) di CI; copy upsell dari template |
| **Pembayaran manual** (kas masuk terlambat) | Pendapatan tertunda | Pengingat otomatis H-3 & H-1, pelacakan jatuh tempo, opsi QRIS, pindah ke payment gateway saat volume naik |
| **Ketergantungan 1 orang (bus factor)** |Proses terhenti | 2 akun SUPERADMIN + 1 OPS + runbook; password & kredensial DB di env/secret manager (bukan repo) |
| **Pengguna single-tenant lama tidak migrasi** | Penutupan mendadak | `inventory_db` tetap bisa jalan via `server.ts`; tidak ada breaking change FE sebelum fase 4 selesai |

---

## 12. Decision Points — **FINAL (dijawab user)**

| # | Keputusan | Opsi | Rekomendasi |
|---|---|---|---|
| 1 | **Nama & merk** | "Quotaku" / "Invcash" / lain | **FINAL: Mayan POS** — console "Mayan POS Console"; domain & endpoint tetap `quotaku.com`/`invcash.quotaku.com` (migrasi domain menyusul opsional) |
| 2 | **Struktur repo platform** | `platform/` (Express) + `fe-super/` (SvelteKit) — atau monorepo satu paket | Pisah: `platform/` (Node) & `fe-super/` (Node) — 2 paket, 2 stack, `node_modules` tidak bercampur |
| 3 | **Identifier tenant & subdomain** | subdomain / kode / UUID | **FINAL: kode tenant (slug) tetap identitas utama. WILDCARD SUBDOMAIN DITUNDA (infra belum siap)** — fase awal routing via **`X-Tenant-Code`** + field "Kode toko" di login Flutter (tenant resolver memakai kode, bukan host). Subdomain diaktifkan belakangan tanpa perubahan kontrak (resolusi host tetap prioritas #1 di router) |
| 4 | **Trial 14 hari** | — | **FINAL: tanpa kartu kredit**, auto-aktivasi trial setelah registrasi web |
| 5 | **Harga** | tabel §6.1 | **FINAL: disetujui** (Basic 99rb/Pro 249rb/Business 499rb; tahunan = 10× bulanan) — **TANPA fitur API publik** (belum ada, lihat baris matrix); tinjau 3 bulan pertama |
| 6 | **Akses read-only ETL ke DB tenant** | role DB khusus `etl_ro` / pakai user aplikasi | Role DB `etl_ro` (SELECT-only) per tenant, dibuat saat provisioning |
| 7 | **Jumlah jenis usaha** | 6 template | 6 (sesuai request); mudah ditambah nanti karena seed berbasis kode |
| 8 | **Struk WA** | fitur berbayar (upsell) atau gratis | **Berbayar** (upsell §7.3); kuota gratis terbatas untuk Pro & Business |
| 9a | **Identitas login owner/kasir** | email / username | **FINAL: USERNAME** (standarisasi — sama seperti sekarang). Registrasi web membuat username owner + kode toko; email hanya kontak opsional (untuk notifikasi/WA) |
| 9 | **Outlet = DB terpisah?** | 1 DB per tenant dengan tabel `outlet` (dipilih) vs 1 DB per outlet | **Tabel `outlet`** (migration 0009) — rekap & katalog tetap satu sumber |
| 10 | **Retensi data tenant saat churn** | hapus langsung / arsip 30 hari / arsip 60 hari | **FINAL: arsip 60 hari** lalu hapus permanen. Dunning: superadmin console menampilkan PERINGATAN "tenant belum membayar tagihan bulan sebelumnya — data akan dihapus permanen" (H+1 unpaid → notifikasi, H+30 peringatan keras + akses read-only, H+60 arsip terakhir + ekspor owner, H+75 hapus permanen) |
| 11 | **Pembayaran langganan** | manual / gateway | **FINAL (SAAS-5):** invoice terbit otomatis tiap periode → sistem membuat **kode pembayaran unik** (mis. `MYN-8842-XK`) → **admin mengirim kode via WhatsApp ke tenant (manual)** → tenant transfer dengan kode tsb sebagai berita → tenant/admin unggah bukti → admin konfirmasi (`POST /platform/payments/:id/confirm`) → periode diperpanjang. Gateway (Midtrans/Xendit) menyusul setelah >30 tenant aktif |

---

## 13. Referensi

- `fase.md` — 13 tabel, trigger, guard DB, ACID, map error, go-live checklist
- `plan-backend-v2-refund-rusak-opname-rbac.md` — pola penulisan plan (alur → use case → RBAC → DDL → task → detail → risiko → keputusan)
- `src/db/migrate.ts` — pola migration idempotent forward-only (0001–0008), `verifyBaseline()`
- `openapi.yaml` — 41 path, `x-error-codes`; versi baru 3.0.0 menambah outlet/subscription/entitlement
- `fe/plan-fe-flutter-tablet.md` + `fe/tasklist-fe.md` — struktur FE, aturan API client (§5.2 Idempotency-Key wajib), matriks role, `Env.apiBaseUrl` (`--dart-define`)
- `menu-matrix.md` — kasir 10 menu, owner 8 menu (tidak berubah; owner += Langganan)
- `tasklist-saas-platform.md` — checklist eksekusi SAAS-0..7
- `fe-super/README.md` — stack & halaman console superadmin
