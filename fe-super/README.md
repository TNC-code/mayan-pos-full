# Mayan POS Console — Superadmin & Web Registrasi

> **STUB dokumentasi — belum ada kode di folder ini.** Folder ini akan berisi aplikasi web
> **SvelteKit + Tailwind** untuk dua keperluan:
> 1. **Console superadmin** (`:4000`) — kelola tenant, plan, outlet, tagihan, analitik omzet, riset produk.
> 2. **Web registrasi tenant** (route group publik) — owner toko mendaftar sendiri, pilih jenis usaha & plan, mulai trial.
>
> Spesifikasi lengkap: [`../plan-saas-platform.md`](../plan-saas-platform.md) · Eksekusi: [`../tasklist-saas-platform.md`](../tasklist-saas-platform.md)

---

## 1. Identitas

| Item | Nilai |
|---|---|
| Nama | **Mayan POS Console** (nama kerja; alternatif: *Mayan POS Admin*) |
| Fungsi | Console internal distributor + halaman registrasi publik |
| Pengguna | Superadmin, OPS, Viewer (internal distributor) · **bukan** untuk tenant |
| Stack | **SvelteKit** (Svelte 5, TypeScript) + **Tailwind CSS** |
| Dev port | **4000** |
| API | Platform API `http://localhost:4001/api/v1` (proxy `/api/platform/*`) |
| Produksi | `app.quotaku.com` (console) · `www.quotaku.com` (registrasi) — reverse proxy + HTTPS |

> Catatan: aplikasi POS tenant (**Flutter tablet**) tidak ada di sini —ia di folder `fe/`. Folder ini
> hanya untuk sisi platform (superadmin + registrasi).

---

## 2. Menjalankan (dev)

```bash
cd fe-super
npm install
cp .env.example .env      # API_BASE_URL=http://localhost:4001/api/v1
npm run dev               # http://localhost:4000
```

Isi `.env`:

```bash
API_BASE_URL=http://localhost:4001/api/v1
# ORIGIN=http://localhost:4000   # untuk SvelteKit (dev)
```

Build & preview:

```bash
npm run build
npm run preview           # cek hasil build sebelum deploy
```

---

## 3. Struktur folder (rencana)

```
fe-super/
├── README.md
├── package.json                  # sveltekit + tailwind + adapter-node
├── svelte.config.js
├── vite.config.ts
├── tsconfig.json
├── .env.example
├── src/
│   ├── app.html
│   ├── app.css                   # token Tailwind (warna, tipografi)
│   ├── app.d.ts
│   ├── hooks.server.ts           # sesi superadmin (cookie) + guard route
│   ├── lib/
│   │   ├── server/
│   │   │   ├── api.ts            # fetch ke Platform API (base URL dari env)
│   │   │   ├── session.ts        # cookie sesi (JWT superadmin + refresh)
│   │   │   └── format.ts         # rupiah, tanggal Asia/Jakarta, angka
│   │   ├── components/
│   │   │   ├── DataTable.svelte  # sort + filter + pagination
│   │   │   ├── StatCard.svelte    # MRR, tenant aktif, omzet hari ini
│   │   │   ├── ChartLine.svelte   # tren omzet
│   │   │   ├── ChartBar.svelte    # omzet per jenis usaha / kategori
│   │   │   ├── Sparkline.svelte   # mini tren per tenant
│   │   │   ├── StatusBadge.svelte # ACTIVE / TRIAL / PAST_DUE / EXPIRED / SUSPENDED
│   │   │   ├── Modal.svelte       # konfirmasi tindakan sensitif
│   │   │   └── EmptyState.svelte
│   │   └── types/                # Tenant, Plan, Subscription, Invoice, UsageDaily, ...
│   └── routes/
│       ├── (public)/             # tanpa auth — web registrasi
│       │   ├── +page.svelte                  # landing & marketing
│       │   ├── daftar/                      # wizard registrasi (4 langkah)
│       │   ├── harga/                       # daftar harga (dari /public/plans)
│       │   └── status/                      # cek status provisioning (?token=)
│       └── (console)/            # auth superadmin
│           ├── login/
│           ├── +layout.svelte                # sidebar + topbar + guard sesi
│           ├── +page.svelte                  # ringkasan (dashboard)
│           ├── tenants/                      # daftar & detail tenant
│           │   ├── +page.svelte
│           │   └── [code]/+page.svelte       # detail: profil, plan, outlet, ETL, audit
│           ├── subscriptions/                # langganan & upgrade/downgrade
│           ├── invoices/                     # tagihan & konfirmasi bayar
│           ├── analytics/                    # omzet (lihat §5)
│           ├── product-market/               # riset produk lintas tenant
│           │   ├── +page.svelte
│           │   └── categories/               # kurasi kategori tenant → platform
│           ├── plans/                        # editor plan & fitur
│           ├── jobs/                         # status ETL / provisioning
│           └── settings/                     # platform settings, templates jenis usaha
└── static/                     # logo, favicon
```

---

## 4. Halaman superadmin

| Halaman | Route | Isi |
|---|---|---|
| **Login** | `/login` | email + password superadmin; peser error 401; countdown bila kena rate limit 429 |
| **Dashboard** | `/` | kartu MRR, tenant aktif, tenant trial, invoice jatuh tempo; grafik omzet 30 hari; job ETL terakhir |
| **Daftar tenant** | `/tenants` | tabel: kode, nama, jenis usaha, plan, status, omzet bulan ini, transkasi, ETL; filter & pencarian; aksi: suspend/reinstate, hapus |
| **Detail tenant** | `/tenants/[code]` | profil & kontak · plan & entitlements (fitur aktif) · outlet · subscription · riwayat invoice · status ETL · log audit tenant · provisioning job |
| **Subscriptions** | `/subscriptions` | daftar langganan (status TRIAL/ACTIVE/PAST_DUE/EXPIRED/SUSPENDED), aksi upgrade/downgrade/pause, masa aktif & berakhir |
| **Invoices** | `/invoices`, `/invoices/[no]` | daftar & detail tagihan, bukti transfer, tombol **Konfirmasi Pembayaran** (memperpanjang periode + sinkron entitlement) |
| **Analitik omzet** | `/analytics` | omzet platform per hari/bulan, tren, per jenis usaha, ranking tenant |
| **Analitik per tenant** | `/analytics/omzet` | omzet per tenant & per outlet, filter periode & jenis usaha |
| **Health tenant** | `/analytics/health` | health score: transaksi/hari, hari aktif, produk aktif, status langganan, status ETL |
| **Product market** | `/product-market` | top produk lintas tenant (qty, omzet, HPP, margin), tren, produk naik, jumlah tenant per produk |
| **Kurasi kategori** | `/product-market/categories` | map kategori tenant → kategori platform; metrik coverage |
| **Jobs** | `/jobs` | status ETL harian & provisioning per tenant; re-run per tenant |
| **Editor plan** | `/plans` | harga bulanan/tahunan, batas outlet & user, fitur (checkbox flag), urutan, aktif/nonaktif |
| **Audit** | `/settings/audit` (atau tab) | aktivitas penting: aksi siapa, kapan, tenant mana |
| **Settings** | `/settings` | template jenis usaha, pengaturan trial, akun superadmin |

> Halaman **registrasi publik** ada di route group `(public)` (lihat §3): `/daftar` (wizard), `/harga`, `/status`.

---

## 5. Halaman publik (registrasi tenant)

| Route | Isi |
|---|---|
| `/` | landing: hero, cara kerja, harga, FAQ, tombol daftar |
| `/daftar` | wizard 4 langkah: **jenis usaha → data toko/owner → pilih plan → mulai trial 14 hari** |
| `/daftar/berhasil` | kode toko, username, base URL tenant, tombol buka POS & QR |
| `/harga` | harga & fitur per plan (dari `GET /platform/public/plans`) |
| `/status` | cek status provisioning via token (tanpa login) |

Jenis usaha (6): Konter Pulsa · Minimarket/Warung Sembako · Kosmetik · Vitamin/Suplemen · Aksesoris HP · Agen/Grosir kecil. Registrasi tidak meminta kartu kredit.

---

## 6. Integrasi dengan Platform API

Semua panggilan lewat **Platform API** (`platform/`, port **4001**) — console tidak pernah menyentuh DB tenant secara langsung.

| Kebutuhan | Endpoint (rencana) | Auth |
|---|---|---|
| Login superadmin | `POST /api/v1/platform/auth/login`, `/refresh`, `/logout`, `GET /me` | JWT superadmin |
| Daftar tenant (publik) | `POST /api/v1/platform/registrations` | publik (rate-limited) |
| Data publik | `GET /api/v1/platform/public/plans`, `/public/business-types` | publik |
| Daftar/detail tenant | `GET/POST/PATCH /api/v1/platform/tenants`, `/tenants/:code` | superadmin |
| Suspend/reinstate | `POST /api/v1/platform/tenants/:code/suspend` · `/reinstate` | superadmin |
| Plan | `GET/POST/PATCH /api/v1/platform/plans` | superadmin/ops |
| Subscription | `GET /api/v1/platform/subscriptions`, `POST /:id/change-plan` | superadmin/ops |
| Invoice | `GET /api/v1/platform/invoices`, `POST /tenants/:id/invoice` | superadmin/ops |
| Konfirmasi bayar | `POST /api/v1/platform/payments/:id/confirm` (atau `/reject`) | superadmin/ops |
| Analitik | `GET /api/v1/platform/analytics/omzet`, `/tenants/:code`, `/product-market` | semua role console |
| Kurasi kategori | `GET/POST /api/v1/platform/categories/map` | superadmin/ops |
| Ekspor CSV | `GET /api/v1/platform/exports/products.csv`, `/revenue.csv` | superadmin/ops (dicatat di audit) |
| Jobs / ETL | `GET /api/v1/platform/jobs`, `POST /jobs/etl` (re-run per tenant) | superadmin |
| Audit | `GET /api/v1/platform/audit` | superadmin |

**Aturan integrasi**

- Base URL Platform API dari env (`API_BASE_URL`); saat dev, SvelteKit mem-proxy `/api/platform/*` agar tidak ada masalah CORS.
- Sesi disimpan di **cookie httpOnly** (hooks.server.ts + `handle`), bukan `localStorage`; guard di `(console)/+layout.svelte` — belum login → `/login`.
- Role console: **SUPERADMIN** (semua), **OPS** (tenant/subscription/invoice; tidak bisa hapus tenant), **VIEWER** (hanya baca dashboard).
- Tampilan uang & tanggal mengikuti format lokal: rupiah (`id-ID`) dan tanggal Asia/Jakarta.
- Semua aksi mutasi tercatat di `audit_log` oleh Platform API (console cukup menampilkan).

---

## 7. Catatan & batasan (fase ini)

- Folder ini **hanya stub** — belum ada `package.json`, `src/`, atau dependensi yang terpasang. Inisialisasi terjadi di **SAAS-1** (tasklist: scaffold + wizard `/daftar`).
- CORS Platform API hanya mengizinkan origin console (`app.quotaku.com` / `localhost:4000` saat dev).
- Halaman **Product market** & **kurasi kategori** dibangun bertahap: dasar di SAAS-3, lengkap di SAAS-6.
- Harga & fitur di `/harga` **selalu diambil dari API** (`/public/plans`), tidak ditulis hardcode di console.
- Status pengerjaan tiap halaman dicatat di `tasklist-saas-platform.md` (fase SAAS-1 dst).
