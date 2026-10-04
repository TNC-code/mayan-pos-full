import { pool, closePool, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';

/**
 * BASELINE MIGRATION
 * ------------------------------------------------------------------
 * Schema utama (13 tabel + trigger) SUDAH ADA di DB dan TIDAK boleh diubah
 * (hanya DML dari aplikasi). Jadi baseline di sini NO-OP terhadap schema itu.
 *
 * Yang dibuat di sini hanya:
 *  1. Tabel `idempotency_keys`  -> satu-satunya tabel baru yang diizinkan
 *     (anti double-submit multi POS, lihat fase.md "Aturan wajib aplikasi" #2).
 *  2. Sequence penomoran dokumen  -> sale_no / batch_code / opname_no wajib dari
 *     SEQUENCE DB (bukan max(timestamp)+1) supaya unik saat 2 POS submit bersamaan.
 *
 * Semua idempotent (aman dijalankan berkali-kali).
 */
const MIGRATION_NAME = '0001_baseline_idempotency_and_sequences';

const DDL = `
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
    key         text        PRIMARY KEY,
    response    jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS public.sale_no_seq    AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.batch_code_seq AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.opname_no_seq  AS bigint START WITH 1 INCREMENT BY 1;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON public.idempotency_keys (created_at);
`;

const MIGRATION_NAME_2 = '0002_operational_expenses';

const DDL2 = `
CREATE TABLE IF NOT EXISTS public.operational_expenses (
    id           bigserial     PRIMARY KEY,
    expense_date date          NOT NULL DEFAULT CURRENT_DATE,
    category     varchar(50)   NOT NULL,
    description  text,
    amount       numeric(14,2) NOT NULL,
    created_by   integer       REFERENCES public.user_account(id),
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT chk_opex_amount_positive CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_opex_date     ON public.operational_expenses (expense_date);
CREATE INDEX IF NOT EXISTS idx_opex_category ON public.operational_expenses (category);
`;

const MIGRATION_NAME_3 = '0003_p0_p1_p2_hardening';

const DDL3 = `
-- P0: role tersimpan di DB (bukan lagi cuma mapping .env)
ALTER TABLE public.user_account ADD COLUMN IF NOT EXISTS role varchar(10) NOT NULL DEFAULT 'KASIR';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_role') THEN
    ALTER TABLE public.user_account ADD CONSTRAINT chk_user_role CHECK (role IN ('OWNER','KASIR'));
  END IF;
END $$;

-- P0: marking data uji agar tidak mencemari laporan produksi
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_sales_is_test ON public.sales (is_test);

-- P1: refund untuk penjualan yang sudah dibayar
CREATE TABLE IF NOT EXISTS public.refunds (
    id          bigserial     PRIMARY KEY,
    sale_id     bigint        NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
    method_id   integer       REFERENCES public.payment_methods(id) ON DELETE RESTRICT,
    amount      numeric(14,2) NOT NULL,
    reason      text          NOT NULL,
    refunded_at timestamptz  NOT NULL DEFAULT now(),
    refunded_by integer       REFERENCES public.user_account(id),
    CONSTRAINT chk_refund_amount_positive CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_refunds_sale ON public.refunds (sale_id);

-- P1: sesi kasir / cash drawer shift
CREATE TABLE IF NOT EXISTS public.cash_sessions (
    id           bigserial     PRIMARY KEY,
    user_id      integer       NOT NULL REFERENCES public.user_account(id),
    opening_cash numeric(14,2) NOT NULL DEFAULT 0,
    opened_at    timestamptz  NOT NULL DEFAULT now(),
    closed_at    timestamptz,
    closing_cash numeric(14,2),
    expected_cash numeric(14,2),
    difference   numeric(14,2),
    status       varchar(10)   NOT NULL DEFAULT 'OPEN',
    note         text,
    CONSTRAINT chk_cash_session_status CHECK (status IN ('OPEN','CLOSED')),
    CONSTRAINT chk_opening_cash_nonneg CHECK (opening_cash >= 0)
);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_user   ON public.cash_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON public.cash_sessions (status);

-- P1: refresh token (logout/revoke)
CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    token_hash text        PRIMARY KEY,
    user_id    integer     NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON public.refresh_tokens (user_id);

-- P2: PPN per transaksi, stok minimum (alert), konversi satuan jual
ALTER TABLE public.sales    ADD COLUMN IF NOT EXISTS tax_amount numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.product  ADD COLUMN IF NOT EXISTS min_stock numeric(14,3) NOT NULL DEFAULT 0;
ALTER TABLE public.product  ADD COLUMN IF NOT EXISTS unit_conversions jsonb;

-- P1: revisi trigger void -> VOIDED tetap ditolak jika sudah dibayar,
-- RETURNED (retur + refund) DIIZINKAN walau sudah dibayar (refund dicatat di tabel refunds).
CREATE OR REPLACE FUNCTION public.fn_sales_void() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    IF NEW.voided_at   IS DISTINCT FROM OLD.voided_at
       OR NEW.voided_by IS DISTINCT FROM OLD.voided_by
       OR NEW.void_reason IS DISTINCT FROM OLD.void_reason THEN
      RAISE EXCEPTION 'Metadata void tidak boleh diubah tanpa perubahan status';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Hanya penjualan COMPLETED yang dapat di-void/return (status: %)', OLD.status;
  END IF;
  IF NEW.status NOT IN ('VOIDED','RETURNED') THEN
    RAISE EXCEPTION 'Transisi % -> % tidak diizinkan', OLD.status, NEW.status;
  END IF;
  NEW.voided_at := COALESCE(NEW.voided_at, now());
  IF NEW.voided_by IS NULL OR NEW.void_reason IS NULL THEN
    RAISE EXCEPTION 'voided_by dan void_reason wajib diisi';
  END IF;
  IF NEW.status = 'VOIDED' AND OLD.payment_status <> 'UNPAID' THEN
    RAISE EXCEPTION 'Tidak dapat void penjualan yang sudah dibayar; gunakan retur/refund';
  END IF;
  RETURN NEW;
END $$;
`;

const MIGRATION_NAME_4 = '0004_store_profile';

const DDL4 = `
-- Profil toko/perusahaan untuk header nota & receipt (single row, id=1).
CREATE TABLE IF NOT EXISTS public.store_profile (
    id              integer      PRIMARY KEY DEFAULT 1,
    name            varchar(150) NOT NULL DEFAULT 'Toko Saya',
    address         text,
    phone           varchar(30),
    email           varchar(100),
    npwp            varchar(40),
    receipt_footer  text,
    logo_url        text,
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    updated_by      integer      REFERENCES public.user_account(id),
    CONSTRAINT chk_store_single_row CHECK (id = 1)
);
INSERT INTO public.store_profile (id, name) VALUES (1, 'Toko Saya') ON CONFLICT (id) DO NOTHING;
`;

const MIGRATION_NAME_5 = '0005_refund_rusak_opname';

const DDL5 = `
-- 1) Stok rusak (karantina, tidak dijual POS karena validasi jual hanya baca qty_remaining)
ALTER TABLE public.stock_batches ADD COLUMN IF NOT EXISTS qty_damaged numeric(14,3) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_batch_damaged_nonneg'
                   AND conrelid = 'public.stock_batches'::regclass) THEN
    ALTER TABLE public.stock_batches
      ADD CONSTRAINT chk_batch_damaged_nonneg CHECK (qty_damaged >= 0);
  END IF;
END $$;

-- 2) Ledger: kondisi per movement (baris lama otomatis default GOOD)
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS condition varchar(10) NOT NULL DEFAULT 'GOOD';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_stock_movement_condition'
                   AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE public.stock_movements
      ADD CONSTRAINT chk_stock_movement_condition CHECK (condition IN ('GOOD','RUSAK'));
  END IF;
END $$;

-- 3) Refund parsial: detail per item (qty + kondisi + snapshot harga jual)
CREATE TABLE IF NOT EXISTS public.refund_items (
    id           bigserial     PRIMARY KEY,
    refund_id    bigint        NOT NULL REFERENCES public.refunds(id) ON DELETE RESTRICT,
    sale_item_id bigint        NOT NULL REFERENCES public.sale_items(id) ON DELETE RESTRICT,
    qty          numeric(14,3) NOT NULL CHECK (qty > 0),
    condition    varchar(10)   NOT NULL DEFAULT 'GOOD',
    unit_price   numeric(14,2) NOT NULL,
    subtotal     numeric(14,2) NOT NULL,
    CONSTRAINT chk_refund_item_condition CHECK (condition IN ('GOOD','RUSAK'))
);
CREATE INDEX IF NOT EXISTS idx_refund_items_refund    ON public.refund_items (refund_id);
CREATE INDEX IF NOT EXISTS idx_refund_items_sale_item ON public.refund_items (sale_item_id);

-- 4) Retur ke distributor (barang rusak karantina -> kembali ke supplier)
CREATE SEQUENCE IF NOT EXISTS public.supplier_return_no_seq AS bigint START WITH 1 INCREMENT BY 1;
CREATE TABLE IF NOT EXISTS public.supplier_returns (
    id                 bigserial     PRIMARY KEY,
    return_no          text          NOT NULL UNIQUE,
    supplier_name      text          NOT NULL,
    status             varchar(12)   NOT NULL DEFAULT 'PENDING',
    total_cost         numeric(14,2) NOT NULL DEFAULT 0,
    refunded_amount    numeric(14,2),
    refunded_method_id integer       REFERENCES public.payment_methods(id) ON DELETE RESTRICT,
    refunded_at        timestamptz,
    settled_by         integer       REFERENCES public.user_account(id),
    note               text,
    created_by         integer       REFERENCES public.user_account(id),
    created_at         timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT chk_supplier_return_status CHECK (status IN ('PENDING','REFUNDED','WRITTEN_OFF'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_status ON public.supplier_returns (status, id DESC);

CREATE TABLE IF NOT EXISTS public.supplier_return_items (
    id         bigserial     PRIMARY KEY,
    return_id  bigint        NOT NULL REFERENCES public.supplier_returns(id) ON DELETE RESTRICT,
    product_id integer       NOT NULL REFERENCES public.product(id) ON DELETE RESTRICT,
    batch_id   bigint        REFERENCES public.stock_batches(id) ON DELETE RESTRICT,
    qty        numeric(14,3) NOT NULL CHECK (qty > 0),
    unit_cost  numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
    condition  varchar(10)   NOT NULL DEFAULT 'RUSAK',
    CONSTRAINT chk_supplier_return_item_condition CHECK (condition IN ('GOOD','RUSAK'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_return_items_return ON public.supplier_return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_supplier_return_items_batch  ON public.supplier_return_items (batch_id);

-- 5) Opex jejak otomatis (settle retur distributor yang ditolak = barang rusak)
ALTER TABLE public.operational_expenses ADD COLUMN IF NOT EXISTS source varchar(12) NOT NULL DEFAULT 'MANUAL';
ALTER TABLE public.operational_expenses
  ADD COLUMN IF NOT EXISTS supplier_return_id bigint REFERENCES public.supplier_returns(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_opex_supplier_return ON public.operational_expenses (supplier_return_id);

-- 6) Opname detail: hitung fisik barang rusak + penyebab selisih
ALTER TABLE public.stock_opname_items ADD COLUMN IF NOT EXISTS physical_qty_damaged numeric(14,3);
ALTER TABLE public.stock_opname_items ADD COLUMN IF NOT EXISTS cause varchar(12);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_opname_item_physical_damaged'
                   AND conrelid = 'public.stock_opname_items'::regclass) THEN
    ALTER TABLE public.stock_opname_items
      ADD CONSTRAINT chk_opname_item_physical_damaged CHECK (physical_qty_damaged IS NULL OR physical_qty_damaged >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_opname_item_cause'
                   AND conrelid = 'public.stock_opname_items'::regclass) THEN
    ALTER TABLE public.stock_opname_items
      ADD CONSTRAINT chk_opname_item_cause
      CHECK (cause IS NULL OR cause IN ('RUSAK','HILANG','SALAH_HITUNG','LAIN'));
  END IF;
END $$;

-- 7) Revisi trigger: satu aturan restock tunggal yang sadar kondisi
--    GOOD -> qty_remaining (barang bisa dijual lagi)
--    RUSAK -> qty_damaged  (karantina; OUT mis. SUPPLIER_RETURN menguranginya)
CREATE OR REPLACE FUNCTION public.fn_stock_movement_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_damaged_before numeric(14,3);
BEGIN
    IF NEW.batch_id IS NOT NULL THEN
        IF COALESCE(NEW.condition, 'GOOD') = 'RUSAK' THEN
            -- Kunci baris batch supaya movement IN/OUT barang rusak dari 2 POS tidak saling menimpa.
            SELECT qty_damaged INTO v_damaged_before
              FROM stock_batches
             WHERE id = NEW.batch_id
               FOR UPDATE;

            -- Dicek SEBELUM update: kalau sesudahnya, constraint chk_batch_damaged_nonneg
            -- yang lebih dulu menolak dan pesan penjelasannya hilang.
            IF v_damaged_before + NEW.qty_change < 0 THEN
                RAISE EXCEPTION 'Stok rusak batch % tidak cukup: tersedia %, diminta %',
                    NEW.batch_id, v_damaged_before, -NEW.qty_change;
            END IF;

            UPDATE stock_batches
               SET qty_damaged = qty_damaged + NEW.qty_change
             WHERE id = NEW.batch_id;
        ELSE
            -- Perilaku GOOD tidak berubah sejak baseline: IN/OUT/ADJUSTMENT ke qty_remaining.
            UPDATE stock_batches
               SET qty_remaining = qty_remaining + NEW.qty_change
             WHERE id = NEW.batch_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- 8) fn_sales_void_apply dimatikan: stok balik (void/retur) sekarang ditulis
--    SATU PENULIS di layer service (sale.service.ts) per item + condition, supaya
--    barang rusak bisa dilabeli RUSAK dan tidak terhitung dua kali.
--    fn_sales_void (validasi transisi status) TIDAK disentuh.
CREATE OR REPLACE FUNCTION public.fn_sales_void_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RETURN NEW;
END $$;
`;

const MIGRATION_NAME_6 = '0006_opname_damaged_snapshot';

const DDL6 = `
-- 1) Snapshot stok rusak saat opname (padanan system_qty barangGOOD).
--    Wajib kolom ini: system_qty_damaged tidak bisa dibaca ulang saat detail/report
--    karena stok bergerak terus - yang benar adalah nilai saat opname dilakukan.
ALTER TABLE public.stock_opname_items
  ADD COLUMN IF NOT EXISTS system_qty_damaged numeric(14,3) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_opname_item_system_damaged'
                   AND conrelid = 'public.stock_opname_items'::regclass) THEN
    ALTER TABLE public.stock_opname_items
      ADD CONSTRAINT chk_opname_item_system_damaged CHECK (system_qty_damaged >= 0);
  END IF;
END $$;

-- 2) Selisih barang rusak = fisik - sistem. NULL physical_qty_damaged (opname lama /
--    tidak menghitung barang rusak) diperlakukan sama dengan sistem -> tanpa adjustment.
ALTER TABLE public.stock_opname_items
  ADD COLUMN IF NOT EXISTS damaged_difference numeric(14,3)
  GENERATED ALWAYS AS (COALESCE(physical_qty_damaged, system_qty_damaged) - system_qty_damaged) STORED;

-- 3) Bukti transfer saat distributor mengembalikan uang retur barang rusak.
ALTER TABLE public.supplier_returns ADD COLUMN IF NOT EXISTS refund_reference_no text;

-- 3b) Perbaikan lebar kolom: 0005 membuat kolom source varchar(12) padahal nilai yang
--     dipakai untuk opex write-off adalah 'SUPPLIER_RETURN' (15 karakter) -> di-lebarkan
--     supaya retur distributor yang ditolak bisa tercatat sebagai opex.
ALTER TABLE public.operational_expenses ALTER COLUMN source TYPE varchar(20);

-- 4) Index pendukung laporan analisa opname (per cause & per tanggal).
CREATE INDEX IF NOT EXISTS idx_opname_items_cause   ON public.stock_opname_items (cause);
CREATE INDEX IF NOT EXISTS idx_stock_opnames_date   ON public.stock_opnames (opname_date);
`;

const MIGRATION_NAME_7 = '0007_opex_is_test';

const DDL7 = `
-- Tanda data uji pada tabel opex (padanan sales.is_test sejak migration 0003).
-- CATATAN: tabel operational_expenses dibuat manual di luar migration, jadi tidak punya
-- flag data uji - P&L jadi tercemar opex write-off dari skrip uji (temuan T3/T4).
-- Default false -> opex produksi tidak tersentuh; hanya ditandai oleh 'npm run mark-test-data'.
ALTER TABLE public.operational_expenses
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_opex_is_test ON public.operational_expenses (is_test);
`;

const MIGRATION_NAME_8 = '0008_supplier_return_is_test';

const DDL8 = `
-- Tanda data uji pada tabel retur distributor (padanan sales.is_test / operational_expenses.is_test).
-- CATATAN: tanpa kolom ini, refund_distributor di P&L ikut memuat uang refund dari retur uji
-- (T3/T4) - Mis. Rp140.000 per 2026-10. Tabel supplier_returns dibuat di migration 0005
-- sehingga tidak punya flag uji.
-- Default false -> retur produksi tidak tersentuh; hanya ditandai 'npm run mark-test-data'.
ALTER TABLE public.supplier_returns
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
-- Partial index: hanya retur produksi berstatus REFUNDED yang dibutuhkan pnlReport,
-- jadi baris uji tidak ikut ocupa index.
CREATE INDEX IF NOT EXISTS idx_supplier_returns_is_test
  ON public.supplier_returns (refunded_at)
  WHERE is_test = false AND status = 'REFUNDED';
`;

export async function migrate(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(DDL);
    await client.query(DDL2);
    await client.query(DDL3);
    await client.query(DDL4);
    await client.query(DDL5);
    await client.query(DDL6);
    await client.query(DDL7);
    await client.query(DDL8);

    // P0: sinkronkan role OWNER awal dari konfigurasi .env ke kolom DB.
    const owners = [...env.roles.owner, ...[]].filter(Boolean);
    if (owners.length > 0) {
      await client.query(
        `UPDATE public.user_account SET role = 'OWNER' WHERE lower(username) = ANY($1::text[])`,
        [owners],
      );
    }

    // Lanjutkan penomoran di belakang data yang sudah ada (mis. INV-20261004-001)
    // supaya tidak bentrok dengan UNIQUE sale_no / batch_code yang sudah terpakai.
    const sales = await client.query<{ next: number }>(`
      SELECT COALESCE(MAX(NULLIF(regexp_replace(sale_no, '^.*-', ''), '')::int), 0) + 1 AS next
        FROM public.sales
       WHERE sale_no ~ '^[A-Z]+-[0-9]{8}-[0-9]+$'
    `);
    const batches = await client.query<{ next: number }>(`
      SELECT COALESCE(MAX(NULLIF(regexp_replace(batch_code, '^.*-', ''), '')::int), 0) + 1 AS next
        FROM public.stock_batches
       WHERE batch_code ~ '^[A-Z]+-[0-9]{8}-[0-9]+$'
    `);
    const opnames = await client.query<{ next: number }>(`
      SELECT COALESCE(MAX(NULLIF(regexp_replace(opname_no, '^.*-', ''), '')::int), 0) + 1 AS next
        FROM public.stock_opnames
       WHERE opname_no ~ '^[A-Z]+-[0-9]{8}-[0-9]+$'
    `);

    // is_called = false -> nextval() berikutnya mengembalikan tepat nilai `next`
    await client.query('SELECT setval($1, $2, false)', ['public.sale_no_seq', sales.rows[0]?.next ?? 1]);
    await client.query('SELECT setval($1, $2, false)', ['public.batch_code_seq', batches.rows[0]?.next ?? 1]);
    await client.query('SELECT setval($1, $2, false)', ['public.opname_no_seq', opnames.rows[0]?.next ?? 1]);
  });
}

/**
 * Verifikasi baseline: pastikan 13 tabel final + trigger penjaga ada.
 * Tidak membuat / mengubah / drop apa pun.
 */
const REQUIRED_TABLES = [
  'product',
  'product_category',
  'product_type',
  'stock_batches',
  'stock_movements',
  'sales',
  'sale_items',
  'payment_methods',
  'payments',
  'stock_opnames',
  'stock_opname_items',
  'customer',
  'user_account',
];

const REQUIRED_TRIGGERS = [
  'trg_sale_item_apply_movement',
  'trg_sale_item_validate',
  'trg_sale_item_guard',
  'trg_sales_void',
  'trg_sales_void_apply',
  'trg_sales_no_delete',
  'trg_payments_validate',
  'trg_payments_sync_status',
  'trg_stock_movement_apply',
  'trg_stock_movement_immutable',
  'trg_batch_update_product_cost',
];

export async function verifyBaseline(): Promise<{ ok: boolean; missingTables: string[]; missingTriggers: string[] }> {
  const t = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES],
  );
  const g = await pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY($1::text[])`,
    [REQUIRED_TRIGGERS],
  );

  const haveTables = new Set(t.rows.map((r) => r.table_name));
  const haveTriggers = new Set(g.rows.map((r) => r.tgname));

  return {
    ok: REQUIRED_TABLES.every((x) => haveTables.has(x)) && REQUIRED_TRIGGERS.every((x) => haveTriggers.has(x)),
    missingTables: REQUIRED_TABLES.filter((x) => !haveTables.has(x)),
    missingTriggers: REQUIRED_TRIGGERS.filter((x) => !haveTriggers.has(x)),
  };
}

const isMain = process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js');

if (isMain) {
  (async () => {
    try {
      const before = await verifyBaseline();
      if (!before.ok) {
        throw new Error(
          `Baseline DB tidak lengkap. Tabel hilang: [${before.missingTables.join(', ')}] ` +
            `Trigger hilang: [${before.missingTriggers.join(', ')}]`,
        );
      }
      console.log(`[migrate] baseline schema final terdeteksi (${REQUIRED_TABLES.length} tabel, ${REQUIRED_TRIGGERS.length} trigger)`);

      await migrate();
      console.log(`[migrate] OK - ${MIGRATION_NAME}`);
      console.log(`[migrate] OK - ${MIGRATION_NAME_2}`);
      console.log(`[migrate] OK - ${MIGRATION_NAME_3}`);
      console.log(`[migrate] OK - ${MIGRATION_NAME_4}`);
      console.log(`[migrate] OK - ${MIGRATION_NAME_5}`);
      console.log(`[migrate] OK - ${MIGRATION_NAME_6}`);
      console.log(`[migrate] OK - ${MIGRATION_NAME_7}`);
      console.log(`[migrate] OK - ${MIGRATION_NAME_8}`);

      const res = await pool.query<{ server_version: string; db_now: Date; db_tz: string }>(
        `SELECT current_setting('server_version') AS server_version, now() AS db_now, current_setting('TimeZone') AS db_tz`,
      );
      console.log(`[migrate] server=${res.rows[0]?.server_version} db_now=${res.rows[0]?.db_now.toISOString()} tz=${res.rows[0]?.db_tz}`);
    } catch (err) {
      console.error('[migrate] GAGAL:', err);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  })();
}
