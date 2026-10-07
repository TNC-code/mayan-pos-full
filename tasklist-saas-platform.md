# Tasklist Eksekusi — Plan Platform SaaS Multi-Tenant

> **STATUS: ⏸️ BACKLOG — DITUNDA (keputusan user).** Semua item belum dieksekusi; aktifkan kembali dengan bilang "mulai SAAS-0".

> Sumber spec: `plan-saas-platform.md` (wajib baca) · Konteks: `fase.md`, `plan-backend-v2-refund-rusak-opname-rbac.md`, `openapi.yaml`, `fe/plan-fe-flutter-tablet.md`, `fe/tasklist-fe.md`
> Status: `[ ]` todo · `[~]` berjalan · `[x]` selesai · `[!]` diblokir
> **Dokumen perencanaan saja.** Belum ada kode yang ditulis; checklist di bawah siap dieksekusi berurutan.
> Gate tiap fase: `npm run typecheck` · `npm run build` · `npm run e2e` (245 PASS) · `npm run concurrency` (18/18) tetap hijau; `fe`: `flutter analyze` 0 issue + `flutter test` hijau.

## Riwayat
- *(kosong — belum ada fase yang dieksekusi)*

---

## Catatan global (WAJIB dibaca sebelum mulai)

1. **Jangan sentuh `src/`, `fe/`, DB, server, `openapi.yaml`** di luar item checklist ini. Semua perubahan backend tenant API harus **diwali SAAS-0** (middleware + entry point baru) dan **diwali SAAS-2** (migration 0009), bukan di tengah-tengah.
2. **Backward compatibility adalah syarat mutlak**: 41 path `openapi.yaml` v2.1.0, JWT lama, `server.ts` (:3000) harus tetap jalan apa adanya. `DEFAULT_TENANT_CODE=acme` menjaga `inventory_db` tetap tenant-1.
3. **Raw SQL, tanpa ORM** — konsisten dengan repo. Tidak ada dependensi berat baru tanpa alasan (izin: `pg`, `express`, `zod`, `jsonwebtoken`, `bcrypt`, `cors` sudah ada).
4. **Idempotensi**: provisioning, migrasi per tenant, dan ETL harus aman dijalankan berkali-kali (pola `migrate.ts` 0001–0008).
5. **Tidak ada PII di platform_db** — ETL hanya mengambil agregat penjualan & produk (§8.1 plan).
6. **Jangan commit** kecuali diminta; `.env` platform & kredensial DB tenant tidak masuk repo.
7. **Urutan wajib**: SAAS-0 → SAAS-1 → SAAS-2 → SAAS-3 → SAAS-4 → SAAS-5 → SAAS-6 → SAAS-7.
   SAAS-4 (Flutter) boleh mulai setelah kontrak API SAAS-2 beku; SAAS-3 boleh paralel dengan SAAS-4.
8. **Estimasi total ±52 hari kerja** (rencana, bukan komitmen) — per fase: SAAS-0 5d · SAAS-1 7d · SAAS-2 6d · SAAS-3 7d · SAAS-4 13d · SAAS-5 4d · SAAS-6 5d · SAAS-7 5d.

---

## SAAS-0 — Fondasi platform (DB platform + auth superadmin + tenant registry) · ±5 hari

### SAAS-0.1 `platform_db` — migration (pola `src/db/migrate.ts`, idempotent forward-only)
- [ ] `platform/src/db/migrate.ts` — `0001_platform_core`: `tenants`, `outlets`, `platform_users`, `platform_sessions`, `platform_tenant_keys`, `platform_settings`
- [ ] `0002_platform_billing`: `subscription_plans`, `subscriptions`, `invoices`, `payment_intents`
- [ ] `0003_platform_analytics`: `usage_daily`, `tenant_product_sales_daily`, `platform_categories`, `tenant_category_map`, `etl_category_rules`
- [ ] `0004_platform_ops`: `audit_log`, `tenant_provisioning_jobs`, `job_runs`, `notifications`
- [ ] Semua `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`; `verifyBaselinePlatform()` seperti pola `verifyBaseline()`
- [ ] `platform/src/db/seed.ts`: 4 plan (Trial/Basic/Pro/Business, harga §6.1), 1 SUPERADMIN + 1 OPS + 1 VIEWER, taksonomi kategori platform, `platform_settings` (trial days, default plan, template version)
- [ ] **Acceptance**: `npm run migrate --workspace platform` idempotent 3×, `verifyBaselinePlatform()` OK, seed idempotent, tidak ada data uji polluting

### SAAS-0.2 Skeleton `platform/` (Express, port 4001)
- [ ] `platform/package.json` (script: `dev`, `build`, `start`, `migrate`, `seed`, `typecheck`), `tsconfig.json` mirror repo
- [ ] `platform/.env.example`: `PLATFORM_PORT=4001`, `PLATFORM_DB_*`, `PLATFORM_JWT_SECRET`, `TENANT_API_DB_USER`, `TEMPLATE_DB=tpl_quotaku`, `CORS_ALLOWLIST`, `REGISTRATION_RATE_LIMIT`
- [ ] `platform/src/config/env.ts` (pola zod `src/config/env.ts`) & `db.ts` (pool + `withTransaction`)
- [ ] `platform/src/app.ts`: `/health` (pool + jumlah tenant), `/openapi.json` (spec `platform/openapi.yaml`), CORS allowlist
- [ ] `platform/src/server.ts` (port 4001)
- [ ] **Acceptance**: `curl :4001/health` OK; 2× restart tidak bocor koneksi

### SAAS-0.3 Auth superadmin + RBAC platform
- [ ] `POST /platform/auth/login` (bcrypt, rate limit 10/15m), `POST /platform/auth/refresh`, `POST /platform/auth/logout`, `GET /platform/auth/me`
- [ ] Role `SUPERADMIN` (all) · `OPS` (tenant, subscription, invoice; bukan hapus) · `VIEWER` (read-only dashboard)
- [ ] `middleware/auth.ts` + `requireRole()`; semua `audit_log` untuk aksi mutasi
- [ ] **Acceptance**: login tiap role benar; 401/403 sesuai matriks; refresh token revoke saat logout

### SAAS-0.4 Tenant registry + entry tenant API
- [ ] `platform/src/services/tenant.service.ts`: create/read/update tenant, suspend/reinstate, plan_code
- [ ] `GET /platform/tenant/entitlements?code=` (untuk tenant API, header service key) → `{plan_code, status, features, max_outlets, max_users, trial_ends_at, current_period_end, token_version}`
- [ ] Register tenant #1: `inventory_db` (code `acme`, `is_admin=true`, `is_grandfathered=true`, plan BUSINESS, jenis usaha dari data sekarang)
- [ ] `src/tenant_api.ts` (entry baru) memakai `buildRouter()` yang sama; `src/middleware/tenant.ts`: resolve tenant (host → `X-Tenant-Code` → `?tenant=` → `DEFAULT_TENANT_CODE`), pool cache per tenant, `tid` claim check
- [ ] `src/config/db.ts` (+ `tenantPool(code)`), `src/middleware/auth.ts` (tambah claim `tid`/`tcode`)
- [ ] CORS allowlist di `src/app.ts` (tabel §3.4 plan)
- [ ] `npm run migrate -- --all` (fan-out ke semua `db_name` di platform_db)
- [ ] **Acceptance**: `inventory_db` terdaftar tenant #1; `X-Tenant-Code: acme` → `/api/v1/auth/login` tetap 200 seperti lama; token tenant A ke host tenant B → 403 `TENANT_TOKEN_MISMATCH`; e2e & concurrency hijau

### SAAS-0.5 Docs
- [ ] `platform/openapi.yaml` (skeleton: auth, tenants, entitlements)
- [ ] Update `README.md` (bagian platform, port 4001, env baru)
- [ ] `fase.md` — tambahkan blok "Platform SaaS" singkat, rujukan plan ini
- [ ] **Acceptance**: 41 path v2.1.0 tidak berubah; spec platform valid (parsed saat boot)

---

## SAAS-1 — Web registrasi + provisioning tenant · ±7 hari

### SAAS-1.1 Endpoint registrasi publik
- [ ] `POST /api/v1/platform/registrations` (publik, rate limit 3/15m/IP, honeypot field, validasi kode tenant, **username owner (standar — bukan email)** & no. WA)
- [ ] Validasi: kode unik & slug-normalized (a-z0-9, 3–24), jenis usaha dari 6 template, plan valid, `#` trial 14 hari
- [ ] `GET /platform/public/plans` & `GET /platform/public/business-types` (untuk halaman marketing, tanpa auth)
- [ ] Respons: `{tenant_code, admin_username, temp_password, base_url, onboarding_token}`
- [ ] **Acceptance**: kode dipakai/terlarang → 409; rate limit 429 terhitung; spam tidak bisa

### SAAS-1.2 Job provisioning (idempotent)
- [ ] `platform/src/services/provisioning.service.ts` + `jobs/provision.ts`: langkah 1–6 dari §4.4 plan
- [ ] `CREATE ROLE t_<kode>` + `CREATE DATABASE t_<kode> OWNER t_<kode> TEMPLATE tpl_quotaku` (tolak bila template sedang dipakai)
- [ ] Jalankan migration runner (`migrate.ts` + 0009 bila sudah ada) ke DB baru; `verifyBaseline()` per DB
- [ ] Seed master: 6 file `platform/src/db/templates/<jenis>.sql` (kategori, tipe produk, metode bayar QRIS/Transfer/Tunai, 1 outlet default, `store_profile`)
- [ ] Role DB read-only ETL: `etl_ro` per tenant (SELECT-only) + `platform_tenant_keys`
- [ ] Checkpoint `tenant_provisioning_jobs` per step; retry aman; kegagalan → status `FAILED` + pesan, tanpa DB yatim
- [ ] **Acceptance**: registrasi 1 tenant → DB ter-clone <60 detik, 1 akun OWNER siap, `verifyBaseline()` OK; gagal di tengah → retry tidak menghasilkan data ganda

### SAAS-1.3 Template DB
- [ ] `tpl_quotaku`: DB kosong + `inventory_pos_migration_v2.sql` + 0001–0008 (dan 0009 saat ada), **tanpa data**
- [ ] Script `platform/src/db/refresh-template.ts` (dipakai dev/ops, dijaga versinya)
- [ ] **Acceptance**: `CREATE DATABASE ... TEMPLATE tpl_quotaku` selalu sukses; template tidak pernah punya koneksi aktif

### SAAS-1.4 Web registrasi (SvelteKit)
- [ ] `fe-super/` scaffold SvelteKit + Tailwind, port **4000**, proxy `/api/platform/*` → `:4001`
- [ ] Landing: hero, cara kerja, harga (dari `/public/plans`), FAQ
- [ ] Wizard `/daftar` 4 langkah (jenis usaha → data toko/owner → pilih plan → trial) + validasi server-side
- [ ] `/daftar/berhasil`: tampilkan kode toko, username, base URL, tombol "Masuk ke console toko" & QR
- [ ] Halaman status `/status?token=` (cek provisioning tanpa login)
- [ ] **Acceptance**: daftar sampai `ACTIVE` tanpa bantuan manusia; error provisioning tampil jelas + link hubungi support

### SAAS-1.5 Verifikasi
- [ ] 2 jenis usahabeda (mis. KONTER_PULSA & KOSMETIK) → seed master berbeda & sesuai
- [ ] `tenant_api.ts` melayani tenant baru via `X-Tenant-Code`; transaksi uji berhasil (1 penjualan + opname)
- [ ] Tenant #1 (`inventory_db`) tetap utuh & e2e hijau
- [ ] **Acceptance**: end-to-end registrar → transaksi pertama, <24 jam (target aktivasi)

---

## SAAS-2 — Plan, limit enforcement, feature flag, outlet · ±6 hari

### SAAS-2.1 Migration 0009 (tenant DB)
- [ ] `0009_outlet_and_entitlements`: `outlet` + seed `OUT-01`; `outlet_id` pada `sales`, `purchases`, `stock_opnames`, `cash_sessions`, `user_account`; backfill ke outlet default; trigger default saat INSERT
- [ ] `tenant_entitlements` (1 baris) + sync dari platform (service `entitlement.sync`)
- [ ] Backfill `tenant_entitlements` tenant #1: `plan_code=BUSINESS`, `status=GRANDFATHERED`
- [ ] **Acceptance**: `npm run migrate -- --all` idempotent 3×, semua data lama punya `outlet_id`, ledger tidak berubah

### SAAS-2.2 Entitlement & feature flag di tenant API
- [ ] `src/middleware/entitlement.ts`: ambil entitlement (platform cache 60 detik → fallback baris lokal), pasang di `req`
- [ ] `requireFeature('reports.pnl')`, `requireFeature('reports.opname')`, `requireFeature('export.csv')`, `requireFeature('outlet.multi')`, `requireFeature('api.public')`
- [ ] Limit jumlah: `POST /outlets` & pembuatan user melewati `max_outlets`/`max_users` → 402
- [ ] Error baru: `402 PLAN_LIMIT_REACHED` · `402 SUBSCRIPTION_REQUIRED` · `403 FEATURE_NOT_AVAILABLE` · `403 OUTLET_NOT_ACCESSIBLE` · `403 TENANT_SUSPENDED` · `404 TENANT_NOT_FOUND` · `403 TENANT_TOKEN_MISMATCH` (payload `upsell_url`)
- [ ] Filter `X-Outlet-Id` pada endpoint baca (stok, sales, dashboard, P&L, opname) + default outlet bila header kosong
- [ ] **Acceptance**: matriks §6.2 terverifikasi per plan (Trial/Basic/Pro/Business) via test otomatis

### SAAS-2.3 Endpoint baru (openapi → 3.0.0)
- [ ] `GET /me` → user + `tenant` {code, name, business_type} + `subscription` {plan, status, period_end, trial_ends_at} + `entitlements` {features, limits} + `outlets[]`
- [ ] `GET /outlets` · `POST /outlets` (OWNER, limit) · `PATCH /outlets/{id}` (OWNER) · `POST /outlets/{id}/activate`
- [ ] `GET /subscription` (tagihan aktif, cara bayar, riwayat 3) — proxy ke platform API via service key
- [ ] `POST /sales/{id}/receipt` sertakan info outlet (field opsional; FE lama tidak pecah)
- [ ] Update `openapi.yaml`: versi 3.0.0, path baru, `x-error-codes` baru, `servers` (apex + subdomain)
- [ ] **Acceptance**: 41 path lama tetap sama; test kontrak Basic/Pro/Business hijau

### SAAS-2.4 Status langganan & scheduler
- [ ] Scheduler platform: H-3 trial → `PAST_DUE`/notifikasi; jatuh tempo → `OVERDUE`; +7 hari → `EXPIRED` (read-only); +30 hari → `SUSPENDED` (blok); **+60 hari arsip, +75 hapus permanen (retensi final)**
- [ ] `GET /platform/tenants/:id/sync-entitlement` (push cepat setelah perubahan plan/pembayaran)
- [ ] `token_version` naik saat status/plan berubah → FE refresh token
- [ ] **Acceptance**: simulasi waktu (kneedle tanggal) → semua transisi status sesuai; log ke `audit_log` & `notifications`

---

## SAAS-3 — ETL omzet + dashboard superadmin · ±7 hari

### SAAS-3.1 Job ETL
- [ ] `platform/src/jobs/etl-omzet.ts` (`--tenant=<kode>` opsional, default semua ACTIVE), connect read-only via `etl_ro`
- [ ] Query agregat per §8.2 plan (omzet, HPP, refund, item_qty, trx, active_users, produk per hari) — `status='COMPLETED' AND is_test=false`, TZ Asia/Jakarta
- [ ] Transform: `product_key` normalisasi nama; `platform_category` via 3 tier (§8.4)
- [ ] Load: `UPSERT usage_daily` & `tenant_product_sales_daily`; update `tenants.last_etl_at/etl_status`; catat `job_runs`
- [ ] Cron harian 01:15 Asia/Jakarta (pm2/cron) + retry per tenant (3×) tanpa memblokir tenant lain
- [ ] **Acceptance**: ETL idempotent (2× hasil identik); backfill 30 hari; satu tenant gagal → tenant lain OK

### SAAS-3.2 Rekonsiliasi angka
- [ ] Bandingkan total ETL vs `/reports/pnl` tenant (pendapatan, HPP, refund) — toleransi <1% (beda pembulatan & jam)
- [ ] Catat penyimpangan di `job_runs.detail` untuk ditinjau
- [ ] **Acceptance**: 3 tenant acak, 30 hari, selisih <1%

### SAAS-3.3 Dashboard superadmin (`fe-super`)
- [ ] `/analytics`: omzet platform harian/bulanan, MRR, tren 30 hari
- [ ] `/analytics/omzet`: per tenant, per outlet, per jenis usaha + ranking + filter periode
- [ ] `/analytics/health`: health score per tenant (trx/hari, hari aktif, produk aktif, status langganan, ETL status)
- [ ] `/analytics/etl`: status job per tenant, tombol re-run per tenant
- [ ] Komponen: `DataTable` (sort/filter/pagination), `ChartLine`, `ChartBar`, `Sparkline`, `StatCard`
- [ ] **Acceptance**: data muncul ≤24 jam setelah transaksi; filter periode & jenis usaha berfungsi; loading/empty/error state ada

### SAAS-3.4 Kurasi kategori (dasar)
- [ ] Halaman `/product-market/categories`: daftar kategori tenant belum ter-mapping + form pemetaan ke kategori platform
- [ ] Seed `etl_category_rules` (pulsa & data, kosmetik, vitamin, aksesoris HP, Sembako, minuman, lainnya) + metrik coverage %
- [ ] **Acceptance**: ≥80% baris agregat ter-mapping; mapping manual langsung dipakai ETL berikutnya

---

## SAAS-4 — Perubahan aplikasi Flutter · ±13 hari

> Kontrak API SAAS-2 harus beku sebelum mulai. Detail & estimasi per item: `plan-saas-platform.md` §9.

### SAAS-4.1 Tenant resolver (2d)
- [ ] `lib/core/tenant/tenant_resolver.dart` (baru): input **"kode toko"** (field login — subdomain/URL tetap dikenali bila suatu saat aktif) → `{baseUrl, tenantCode}`; **routing awal via `X-Tenant-Code` (wildcard subdomain DITUNDA user)**
- [ ] `lib/core/config/env.dart`: `API_BASE_URL` jadi **fallback**; `tid` valid
- [ ] `features/auth/login_screen.dart`: field "Kode toko" + validasi sebelum login; header `X-Tenant-Code`
- [ ] `providers/auth_store.dart`: persist tenant code per perangkat
- [ ] Test: unit resolver (kode, subdomain, URL lengkap, huruf besar, spasi, tidak valid) + widget test login
- [ ] **Acceptance**: 2 tenant (kode berbeda) login dari tablet yang sama bergantian tanpa reinstall

### SAAS-4.2 Onboarding ke web (0,5d)
- [ ] Tombol "Belum punya akun? Daftar" → `url_launcher` ke `https://www.quotaku.com/daftar`; dukungan deep link `quotaku://daftar?ref=<kode>`
- [ ] **Acceptance**: tombol membuka browser & kembali ke app; tidak ada form registrasi di dalam app

### SAAS-4.3 Switcher outlet (3d)
- [ ] `api/outlet_api.dart`, `models/outlet.dart`, `providers/outlets.dart` (list, aktif, persist)
- [ ] Header `X-Outlet-Id` via interceptor `dio_client.dart` di semua request
- [ ] `features/shell/app_shell.dart`: dropdown outlet di header (nama + kota); sembunyi bila `outlet.multi=false`
- [ ] `features/settings/outlets_section.dart`: kelola outlet (OWNER), disabled + guard bila limit tercapai
- [ ] **Acceptance**: Pro dengan 3 outlet — ganti outlet → stok/sales terfilter benar; 2 tablet di outlet berbeda tidak saling ganggu

### SAAS-4.4 UX limit plan / upsell (2d)
- [ ] `features/upsell/upsell_sheet.dart`: plan, batas, harga, tombol Upgrade (web/WA sales), "Nanti dulu"
- [ ] Mapping error 402/403 baru di `api_exception.dart` → upsell sheet otomatis
- [ ] Guard proaktif: tombol "Tambah Outlet" & "Export" nonaktif dengan penjelasan bila limit/fitur kurang
- [ ] **Acceptance**: Basic coba tambah outlet ke-2 → upsell sheet, bukan crash/403 mentah

### SAAS-4.5 Status langganan & tagihan (2,5d)
- [ ] `features/owner/subscription_page.dart` + `api/subscription_api.dart`: plan, status, masa aktif, sisa trial, outlet/user terpakai
- [ ] Tagihan aktif: nomor, jumlah, jatuh tempo, cara bayar (rekening/QRIS), upload bukti, riwayat 3 tagihan
- [ ] Badge di `features/owner/dashboard_page.dart` ("Trial 5 hari lagi", "Tagihan jatuh tempo 3 hari")
- [ ] Menu OWNER saja (`router/route_guard.dart` + `features/shell/nav_items.dart`)
- [ ] **Acceptance**: owner Basic melihat tagihan & cara bayar; kasir tidak punya menu ini

### SAAS-4.6 Read-only / force logout (3d)
- [ ] `providers/auth.dart`: baca blok `subscription` dari `/me`; `token_version` naik → refresh
- [ ] `EXPIRED`/`PAST_DUE` → mode read-only: banner oranye, mutasi dinonaktifkan (jual/void/opname), baca & cetak struk tetap boleh
- [ ] `SUSPENDED` → force logout ke layar login + pesan + tombol "Hubungi distributor"
- [ ] `features/pos/pos_page.dart`: guard tombol bayar + tooltip-alasan
- [ ] **Acceptance**: trial habis di app → read-only tanpa kehilangan data; setelah masa tenggang → logout

### SAAS-4.7 Regresi & docs (1d)
- [ ] `flutter analyze` 0 issue · `flutter test` hijau (test lama tidak boleh break)
- [ ] Test baru: resolver, outlet switch, upsell, subscription, read-only
- [ ] `fe/README.md` + `menu-matrix.md` (owner += "Langganan"; matrix role lain tetap)
- [ ] Uji di emulator Pixel Tablet (FE-13.4 regression overflow termasuk halaman baru)
- [ ] **Acceptance**: `flutter build apk --debug` sukses; checklist manual SIGN-OFF

---

## SAAS-5 — Billing manual (transfer + konfirmasi) · ±4 hari

### SAAS-5.1 Invoice
- [ ] `POST /platform/tenants/:id/invoice` (terbit otomatis per periode via scheduler; manual untuk testing)
- [ ] `GET /platform/invoices` (filter status/tenant/periode) · `GET /platform/invoices/:id`
- [ ] `invoices.payment_intents`: instruksi bank & QRIS statis per platform
- [ ] **Acceptance**: invoice terbit tepat 1×/periode/tenant (idempotent), nomor unik

### SAAS-5.2 Konfirmasi manual
- [ ] `POST /platform/payments/:id/confirm` (SUPERADMIN/OPS): catat metode, referensi, bukti → invoice `PAID`, `paid_at`, subscription `ACTIVE`, periode diperpanjang, entitlement disinkron ke tenant DB
- [ ] `POST /platform/payments/:id/reject` dengan alasan → tenant diberi tahu
- [ ] Semua tercatat di `audit_log`
- [ ] **Acceptance**: konfirmasi → tenant langsung bisa pakai fitur berbayar (cache ≤60 detik)

### SAAS-5.3 Halaman invoices & pengingat
- [ ] `/invoices` (tabel, filter, bulk export), `/invoices/[no]` (detail, bukti, tombol konfirmasi)
- [ ] Notifikasi pengingat: H-3 & H-1 jatuh tempo — **admin kirim kode pembayaran via WhatsApp (template pesan + tombol kirim di console)**; `notifications` tercatat
- [ ] **Acceptance**: 1 siklus penuh invoice → bayar → konfirmasi → tenant aktif

### SAAS-5.4 Dokumen
- [ ] ToS ringkas (retensi, data agregat lintas tenant, SLA, harga) — masuk halaman web registrasi
- [ ] **Acceptance**: ToS ditampilkan & dicatat saat registrasi (`audit_log`)

---

## SAAS-6 — Insight distributor lanjutan · ±5 hari

### SAAS-6.1 Product market (riset lintas tenant)
- [ ] `/product-market`: top produk lintas tenant (product_key, jumlah tenant, qty, omzet, HPP, margin%), tren, produk naik, per jenis usaha
- [ ] Drill-down: tenant mana saja yang menjual produk tsb (agregat, tanpa PII)
- [ ] **Acceptance**: daftar 50 produk terlaris lintas tenant dengan angka HPP & margin

### SAAS-6.2 Ekspor CSV
- [ ] `GET /platform/exports/products.csv?dari&sampai&jenis&kategori` (template §8.6)
- [ ] `GET /platform/exports/revenue.csv` (omzet per tenant/outlet/periode)
- [ ] Ekspor tercatat di `audit_log` (siapa, apa filternya)
- [ ] **Acceptance**: CSV sesuai filter; jumlah baris wajar (ribuan, bukan millions) — agregat per hari

### SAAS-6.3 Kurasi kategori lanjutan
- [ ] Halaman kurasi lengkap (bulk map per tenant, coverage per tenant, daftar `LAINNYA`)
- [ ] Template tiap jenis usaha memakai kategori platform sebagai default → `tenant_category_map` terisi sejak provisioning
- [ ] **Acceptance**: coverage ≥90% untuk tenant baru; tenant lama naik bertahap via kurasi

### SAAS-6.4 Bundling & upsell
- [ ] `/catalog-distributor`: katalog produk untuk tenant (harga grosir, MOQ, stok platform) + status ketersediaan
- [ ] Rekomendasi sederhana: "Produk X laku di N tenant sebulan terakhir"
- [ ] Upsell struk WA: paket & biayanya di halaman harga; pencatatan manual (belum integrasi WA API)
- [ ] **Acceptance**: katalog terisi ≥1 jenis usaha; minimal 1 siklus upsell dicatat di console

---

## SAAS-7 — Hardening · ±5 hari

### SAAS-7.1 Audit & keamanan
- [ ] `audit_log` untuk semua aksi sensitif platform (tenant, plan, invoice, ekspor, kredensial) — view & filter di console
- [ ] Rate limit **per tenant** (login 10/15m/tenant, global 600/m/tenant)
- [ ] Password DB per tenant (role DB terpisah) & rotasi; service key per tenant
- [ ] Rate limit registrasi per IP + email/HP; blok daftar massal
- [ ] **Acceptance**: satu tenant tidak bisa memakai/mesruh kuota tenant lain; semua aksi tercatat

### SAAS-7.2 Backup per tenant
- [ ] `scripts/backup-tenants.sh`: loop `pg_dump` per `db_name` + `platform_db`; retensi per plan (7/14/30/90 hari)
- [ ] Verifikasi restore berkala (restore ke DB scratch tiap minggu, cek jumlah tabel & data)
- [ ] Backup `platform_db` (wajib — data billing tidak boleh hilang)
- [ ] **Acceptance**: restore 1 tenant dari backup berhasil & jumlah transaksi cocok

### SAAS-7.3 Monitoring & alert
- [ ] `/health` platform: jumlah koneksi, tenant aktif, ETL terakhir, job gagal
- [ ] Alert: ETL gagal, tenant DOWN, DB hampir penuh, billing overdue
- [ ] `pm2` config: platform API, console, worker ETL; `pm2 save`
- [ ] **Acceptance**: kegagalan ETL terlihat di console & memicu notifikasi

### SAAS-7.4 Data & kepatuhan
- [ ] Halaman "Data Saya" per tenant: apa yang diekstrak, permintaan hapus & ekspor data (CSV)
- [ ] Retensi: hapus `tenant_product_sales_daily` >24 bulan, `usage_daily` >36 bulan (aggregate tahunan)
- [ ] One-click suspend (revoke akses DB) & **arsip 60 hari sebelum drop (keputusan final)**; dunning H+1 notifikasi → H+30 read-only+peringatan keras → H+60 arsip+ekspor owner → H+75 hapus permanen; peringatan tampil di dashboard superadmin ("belum bayar tagihan bulan sebelumnya — data akan dihapus permanen")
- [ ] **Acceptance**: permintaan hapus tenant dari owner → DB diarsip, lalu dihapus sesuai kebijakan; tercatat di `audit_log`

### SAAS-7.5 Uji beban & runbook
- [ ] Load test: 2 tenant × 2 POS bersamaan (idempotency, 409, tidak ada kebocoran antar tenant)
- [ ] Uji skenario jual silang-tenant (token A ke host B → 403)
- [ ] Runbook go-live (deploy, rollback, restore, kredensial, eskalasi) — `docs/runbook-platform.md`
- [ ] Update `README.md` (platform) + `fase.md` (status platform)
- [ ] **Acceptance**: e2e + concurrency + load hijau; runbook ditinjau

---

## Checklist lintas fase (cross-cutting)

- [ ] `openapi.yaml` tenant API naik ke **3.0.0** (path baru + error baru), spec platform terpisah
- [ ] `menu-matrix.md` diperbarui (owner + menu "Langganan"; sisanya tetap)
- [ ] `fe/README.md` diperbarui (tenant resolver, mode multi-tenant)
- [ ] `.env.example` root lengkap untuk platform & tenant (tanpa secret)
- [ ] Semua secret di `.env`/secret manager — tidak pernah di repo
- [ ] Backup sebelum tiap migration tenant yang menyentuh data (>=1× per fase)
- [ ] Estimasi & tanggal aktual tiap fase dicatat di **Riwayat** (atas)
