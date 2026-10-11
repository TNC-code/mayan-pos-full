import type { Sequelize, Transaction } from 'sequelize';
import type { Migration } from '../db/migrator.js';

/**
 * BASELINE MIGRATION — skema FINAL (DB fresh `mayan_pos_dev`).
 *
 * Sumber DDL (sesuai plan §D2):
 *   1. `pg_dump --schema-only` DB lama `inventory_db_dev` (24 tabel, 11 trigger,
 *      index, constraint) — sumber kebenaran bentuk fisik kolom.
 *   2. DDL 0001–0011 di `src/db/migrate.ts` (DML/DDL lama) + DDL entitlement 0012
 *      dari gate raw SQL (plan §D8) — cross-check supaya tidak ada evolusi yang
 *      tertinggal.
 *
 * Isi:
 *   - 24 tabel (13 inti + turunan) dengan PK/UNIQUE/CHECK inline
 *   - 5 sequence penomoran dokumen (sale_no/batch_code/opname_no/
 *     supplier_return_no/order_no) + sequence PK per tabel
 *   - 42 foreign key (guard IF NOT EXISTS -> idempotent)
 *   - seluruh index (termasuk partial unique uq_product_sku/uq_product_barcode
 *     dan partial idx_supplier_returns_is_test)
 *   - 11 trigger penjaga (D3: TETAP di DB, bukan pindah ke aplikasi)
 *   - kolom entitlement `store_profile`: modules/trial_ends_at/suspended_at/
 *     account_status + CHECK 4 status (gate subscription per modul, D8)
 *
 * Catatan keputusan yang TIDAK boleh dibalik:
 *   - `fn_sales_void_apply` SENGAJA PASIF (`RETURN NEW`): pengembalian stok saat
 *     void/retur ditulis SATU PENULIS di service layer per item + kondisi
 *     (GOOD/RUSAK) supaya tidak terhitung dua kali (migrasi lama 0005 §8).
 *   - `fn_stock_movement_apply` tetap melakukan `SELECT ... FOR UPDATE` pada baris
 *     batch untuk movement barang rusak -> anti-oversell antar 2 kasir.
 *   - `fn_batch_update_product_cost` versi 0011 (AFTER INSERT OR UPDATE OF harga,
 *     hanya batch TERBARU yang menyelaraskan harga produk).
 *
 * `sequelize.sync()` tidak pernah dipakai: skema hanya boleh lewat file ini.
 */

/* ------------------------------------------------------------------ *
 * 1) FUNCTION TRIGGER (11) — logika disalin persis dari DB lama
 * ------------------------------------------------------------------ */
const FUNCTIONS_SQL = `
CREATE OR REPLACE FUNCTION public.fn_batch_update_product_cost() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_latest bigint;
BEGIN
    SELECT id INTO v_latest
      FROM public.stock_batches
     WHERE product_id = NEW.product_id
     ORDER BY received_at DESC NULLS LAST, id DESC
     LIMIT 1;

    IF v_latest = NEW.id THEN
        UPDATE product
           SET harga_beli = NEW.unit_cost,
               harga_jual = CASE WHEN NEW.markup_type IS NULL THEN product.harga_jual
                                 ELSE NEW.suggested_price END,
               updated_at = now()
         WHERE id = NEW.product_id;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fn_payments_sync_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_sale_id bigint;
    v_status  varchar(20);
    v_total   numeric(14,2);
    v_paid    numeric(14,2);
    v_new     varchar(20);
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_sale_id := OLD.sale_id;
    ELSE
        v_sale_id := NEW.sale_id;
    END IF;

    SELECT status, total_amount
      INTO v_status, v_total
      FROM public.sales
     WHERE id = v_sale_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Penjualan % tidak ditemukan', v_sale_id;
    END IF;

    IF v_status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'Tidak dapat menambah pembayaran pada penjualan berstatus %', v_status;
    END IF;

    SELECT COALESCE(sum(amount), 0) INTO v_paid
      FROM public.payments
     WHERE sale_id = v_sale_id;

    IF v_paid > v_total THEN
        RAISE EXCEPTION 'Total pembayaran (%) melebihi total penjualan (%)', v_paid, v_total;
    END IF;

    v_new := CASE
                 WHEN v_paid <= 0    THEN 'UNPAID'
                 WHEN v_paid < v_total THEN 'PARTIAL'
                 ELSE 'PAID'
             END;

    UPDATE public.sales SET payment_status = v_new WHERE id = v_sale_id;

    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.fn_payments_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_active boolean;
    v_req    boolean;
BEGIN
    SELECT is_active, requires_reference
      INTO v_active, v_req
      FROM public.payment_methods
     WHERE id = NEW.method_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Metode pembayaran tidak ditemukan';
    END IF;
    IF NOT v_active THEN
        RAISE EXCEPTION 'Metode pembayaran tidak aktif';
    END IF;
    IF v_req AND (NEW.reference_no IS NULL OR btrim(NEW.reference_no) = '') THEN
        RAISE EXCEPTION 'reference_no wajib untuk metode ini';
    END IF;

    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fn_sale_item_apply_movement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_created_by integer;
BEGIN
    SELECT created_by INTO v_created_by FROM public.sales WHERE id = NEW.sale_id;

    INSERT INTO public.stock_movements
        (product_id, batch_id, movement_type, qty_change, unit_cost,
         reference_type, reference_id, note, created_by)
    VALUES
        (NEW.product_id, NEW.batch_id, 'OUT', -NEW.qty, NEW.unit_cost,
         'SALE', NEW.sale_id, 'Auto-deduct penjualan', v_created_by);

    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fn_sale_item_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'sale_items tidak boleh dihapus; gunakan void penjualan';
    END IF;

    IF NEW.sale_id    IS DISTINCT FROM OLD.sale_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.batch_id   IS DISTINCT FROM OLD.batch_id
       OR NEW.qty        IS DISTINCT FROM OLD.qty
       OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
       OR NEW.unit_cost  IS DISTINCT FROM OLD.unit_cost THEN
        RAISE EXCEPTION 'sale_items hanya boleh mengubah kolom note';
    END IF;

    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fn_sale_item_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_cost      numeric(14,2);
    v_remaining numeric(14,3);
BEGIN
    IF NEW.batch_id IS NULL THEN
        RAISE EXCEPTION 'batch_id wajib diisi untuk item penjualan';
    END IF;

    SELECT unit_cost, qty_remaining
      INTO v_cost, v_remaining
      FROM public.stock_batches
     WHERE id = NEW.batch_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Batch % tidak ditemukan', NEW.batch_id;
    END IF;

    IF NEW.unit_price < v_cost THEN
        RAISE EXCEPTION 'Harga jual (%) tidak boleh di bawah harga beli (%)', NEW.unit_price, v_cost;
    END IF;

    IF v_remaining < NEW.qty THEN
        RAISE EXCEPTION 'Stok tidak cukup batch %: tersedia %, diminta %', NEW.batch_id, v_remaining, NEW.qty;
    END IF;

    NEW.unit_cost := v_cost;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fn_sales_no_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'sales tidak boleh dihapus; gunakan void penjualan';
END $$;

CREATE OR REPLACE FUNCTION public.fn_sales_void() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

-- Sengaja pasif: stok saat void/retur dikembalikan oleh SATU PENULIS di
-- service layer (dengan label GOOD/RUSAK), bukan trigger (migrasi lama 0005 §8).
CREATE OR REPLACE FUNCTION public.fn_sales_void_apply() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fn_stock_movement_apply() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE OR REPLACE FUNCTION public.fn_stock_movement_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'stock_movements is an append-only ledger; % is not allowed', TG_OP;
END $$;
`;

/* ------------------------------------------------------------------ *
 * 2) SEQUENCE penomoran dokumen (wajib DB, bukan max(timestamp)+1)
 *    supaya tetap unik saat 2 POS submit bersamaan (fase.md)
 * ------------------------------------------------------------------ */
const SEQUENCES_SQL = `
CREATE SEQUENCE IF NOT EXISTS public.sale_no_seq           AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.batch_code_seq        AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.opname_no_seq         AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.supplier_return_no_seq AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.order_no_seq          AS bigint START WITH 1 INCREMENT BY 1;
`;

/* ------------------------------------------------------------------ *
 * 3) 24 TABEL final-state
 *    serial/bigserial = PK auto increment (urutan kolom sama dengan DB lama)
 * ------------------------------------------------------------------ */
const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS public.cash_sessions (
    id           bigserial     PRIMARY KEY,
    user_id      integer       NOT NULL,
    opening_cash numeric(14,2) NOT NULL DEFAULT 0,
    opened_at    timestamptz   NOT NULL DEFAULT now(),
    closed_at    timestamptz,
    closing_cash numeric(14,2),
    expected_cash numeric(14,2),
    difference   numeric(14,2),
    status       varchar(10)   NOT NULL DEFAULT 'OPEN',
    note         text,
    CONSTRAINT chk_cash_session_status  CHECK (status IN ('OPEN','CLOSED')),
    CONSTRAINT chk_opening_cash_nonneg  CHECK (opening_cash >= 0)
);

CREATE TABLE IF NOT EXISTS public.customer (
    id         serial      PRIMARY KEY,
    name       varchar,
    address    varchar,
    phone      varchar,
    owner_name varchar
);

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
    key        text        PRIMARY KEY,
    response   jsonb       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Kolom role (0003) menggantikan pemetaan role di .env: sumber kebenaran RBAC = DB.
CREATE TABLE IF NOT EXISTS public.user_account (
    id         serial       PRIMARY KEY,
    username   varchar,
    password   varchar,
    full_name  varchar,
    phone      varchar,
    is_active  boolean,
    role       varchar(10)  NOT NULL DEFAULT 'KASIR',
    CONSTRAINT chk_user_role CHECK (role IN ('OWNER','KASIR'))
);

CREATE TABLE IF NOT EXISTS public.operational_expenses (
    id                 bigserial     PRIMARY KEY,
    expense_date       date          NOT NULL DEFAULT CURRENT_DATE,
    category           varchar(50)   NOT NULL,
    description        text,
    amount             numeric(14,2) NOT NULL,
    created_by         integer,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    source             varchar(20)   NOT NULL DEFAULT 'MANUAL',
    supplier_return_id bigint,
    is_test            boolean       NOT NULL DEFAULT false,
    CONSTRAINT chk_opex_amount_positive CHECK (amount > 0)
);

CREATE TABLE IF NOT EXISTS public.order_book_items (
    id            bigserial     PRIMARY KEY,
    order_book_id bigint        NOT NULL,
    product_id    integer,
    product_name  text          NOT NULL,
    raw_text      text,
    qty           numeric(14,3) NOT NULL,
    unit_price    numeric(14,2) NOT NULL DEFAULT 0,
    matched       boolean       NOT NULL DEFAULT false,
    match_score   numeric(4,3),
    CONSTRAINT order_book_items_qty_check      CHECK (qty > 0),
    CONSTRAINT chk_order_item_price_nonneg     CHECK (unit_price >= 0),
    CONSTRAINT chk_order_item_match_score      CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 1))
);

CREATE TABLE IF NOT EXISTS public.order_books (
    id             bigserial      PRIMARY KEY,
    order_no       text           NOT NULL UNIQUE,
    status         varchar(12)    NOT NULL DEFAULT 'PENDING',
    source         varchar(10)    NOT NULL DEFAULT 'WHATSAPP',
    customer_id    integer,
    customer_name  text,
    customer_phone text,
    raw_message    text,
    note           text,
    sale_id        bigint,
    created_by     integer,
    processed_by   integer,
    created_at     timestamptz    NOT NULL DEFAULT now(),
    updated_at     timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT chk_order_book_status CHECK (status IN ('PENDING','PROCESSING','DONE','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS public.payment_methods (
    id                 serial        PRIMARY KEY,
    code               varchar(30)   NOT NULL UNIQUE,
    name               varchar(100)  NOT NULL,
    is_active          boolean       NOT NULL DEFAULT true,
    requires_reference boolean       NOT NULL DEFAULT false,
    bank_name          varchar(100),
    account_no         varchar(50),
    account_name       varchar(100),
    notes              text,
    sort_order         integer       NOT NULL DEFAULT 0,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payments (
    id              bigserial      PRIMARY KEY,
    sale_id         bigint         NOT NULL,
    method_id       integer        NOT NULL,
    amount          numeric(14,2)  NOT NULL,
    tendered_amount numeric(14,2),
    change_amount   numeric(14,2)  GENERATED ALWAYS AS (tendered_amount - amount) STORED,
    reference_no    varchar(100),
    paid_at         timestamptz    NOT NULL DEFAULT now(),
    received_by     integer,
    notes           text,
    created_at      timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT payments_amount_check           CHECK (amount > 0),
    CONSTRAINT chk_payment_tendered_ge_amount   CHECK (tendered_amount IS NULL OR tendered_amount >= amount)
);

-- Kolom desctiption = typo yang melekat di schema lama; di response service
-- tetap diekspos sebagai "description" (FE/openapi). JANGAN dibetulkan di DB.
CREATE TABLE IF NOT EXISTS public.product (
    id               serial       PRIMARY KEY,
    name             varchar,
    category_id      integer,
    desctiption      varchar,
    harga_beli       numeric(14,2),
    harga_jual       numeric(14,2),
    sku              varchar(64),
    unit             varchar(16)  DEFAULT 'pcs',
    attributes       jsonb        NOT NULL DEFAULT '{}'::jsonb,
    is_active        boolean      NOT NULL DEFAULT true,
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now(),
    barcode          varchar(64),
    min_stock        numeric(14,3) NOT NULL DEFAULT 0,
    unit_conversions jsonb
);

CREATE TABLE IF NOT EXISTS public.product_category (
    id       serial  PRIMARY KEY,
    name     varchar,
    id_type  integer,
    is_active boolean
);

CREATE TABLE IF NOT EXISTS public.product_type (
    id        serial  PRIMARY KEY,
    name      varchar,
    is_active boolean
);

CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    token_hash text        PRIMARY KEY,
    user_id    integer     NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.refund_items (
    id           bigserial      PRIMARY KEY,
    refund_id    bigint         NOT NULL,
    sale_item_id bigint         NOT NULL,
    qty          numeric(14,3)  NOT NULL,
    condition    varchar(10)    NOT NULL DEFAULT 'GOOD',
    unit_price   numeric(14,2)  NOT NULL,
    subtotal     numeric(14,2)  NOT NULL,
    CONSTRAINT refund_items_qty_check    CHECK (qty > 0),
    CONSTRAINT chk_refund_item_condition CHECK (condition IN ('GOOD','RUSAK'))
);

CREATE TABLE IF NOT EXISTS public.refunds (
    id           bigserial     PRIMARY KEY,
    sale_id      bigint        NOT NULL,
    method_id    integer,
    amount       numeric(14,2) NOT NULL,
    reason       text          NOT NULL,
    refunded_at  timestamptz   NOT NULL DEFAULT now(),
    refunded_by  integer,
    CONSTRAINT chk_refund_amount_positive CHECK (amount > 0)
);

CREATE TABLE IF NOT EXISTS public.sale_items (
    id         bigserial      PRIMARY KEY,
    sale_id    bigint         NOT NULL,
    product_id integer        NOT NULL,
    batch_id   bigint         NOT NULL,
    qty        numeric(14,3)  NOT NULL,
    unit_price numeric(14,2)  NOT NULL,
    unit_cost  numeric(14,2)  NOT NULL,
    note       text,
    created_at timestamptz    NOT NULL DEFAULT now(),
    subtotal   numeric(16,2)  GENERATED ALWAYS AS (qty * unit_price) STORED,
    CONSTRAINT sale_items_qty_check        CHECK (qty > 0),
    CONSTRAINT sale_items_unit_cost_check  CHECK (unit_cost >= 0),
    CONSTRAINT sale_items_unit_price_check CHECK (unit_price >= 0),
    CONSTRAINT chk_sale_price_ge_cost      CHECK (unit_price >= unit_cost)
);

CREATE TABLE IF NOT EXISTS public.sales (
    id             bigserial     PRIMARY KEY,
    sale_no        varchar(32)   NOT NULL UNIQUE,
    customer_id    integer,
    sale_date      timestamptz   NOT NULL DEFAULT now(),
    total_amount   numeric(14,2) NOT NULL DEFAULT 0,
    note           text,
    created_by     integer,
    created_at     timestamptz   NOT NULL DEFAULT now(),
    status         varchar(20)   NOT NULL DEFAULT 'COMPLETED',
    payment_status varchar(20)   NOT NULL DEFAULT 'UNPAID',
    voided_at      timestamptz,
    voided_by      integer,
    void_reason    text,
    is_test        boolean       NOT NULL DEFAULT false,
    tax_amount     numeric(14,2) NOT NULL DEFAULT 0,
    CONSTRAINT chk_sales_status           CHECK (status IN ('COMPLETED','VOIDED','RETURNED')),
    CONSTRAINT chk_sales_payment_status   CHECK (payment_status IN ('UNPAID','PARTIAL','PAID')),
    CONSTRAINT chk_sales_void_consistency CHECK ((status = 'COMPLETED') = (voided_at IS NULL)),
    CONSTRAINT sales_total_amount_check   CHECK (total_amount >= 0)
);

CREATE TABLE IF NOT EXISTS public.stock_batches (
    id             bigserial      PRIMARY KEY,
    batch_code     varchar(64)    NOT NULL UNIQUE,
    product_id     integer        NOT NULL,
    qty_received   numeric(14,3)  NOT NULL,
    qty_remaining  numeric(14,3)  NOT NULL DEFAULT 0,
    unit_cost      numeric(14,2)  NOT NULL,
    expired_date   date,
    supplier       varchar(128),
    note           text,
    attributes     jsonb          NOT NULL DEFAULT '{}'::jsonb,
    received_at    timestamptz    NOT NULL DEFAULT now(),
    created_by     integer,
    qty_damaged    numeric(14,3)  NOT NULL DEFAULT 0,
    markup_type    varchar(10),
    markup_value   numeric(14,2)  NOT NULL DEFAULT 0,
    suggested_price numeric(14,2) GENERATED ALWAYS AS (
        CASE markup_type
          WHEN 'AMOUNT'  THEN round(unit_cost + markup_value, 2)
          WHEN 'PERCENT' THEN round(unit_cost * (1 + markup_value / 100.0), 2)
          ELSE unit_cost
        END
    ) STORED,
    CONSTRAINT stock_batches_qty_received_check CHECK (qty_received > 0),
    CONSTRAINT stock_batches_qty_remaining_check CHECK (qty_remaining >= 0),
    CONSTRAINT stock_batches_unit_cost_check     CHECK (unit_cost >= 0),
    CONSTRAINT chk_batch_damaged_nonneg           CHECK (qty_damaged >= 0),
    CONSTRAINT chk_batch_remaining_le_received    CHECK (qty_remaining <= qty_received),
    CONSTRAINT chk_batch_markup_type              CHECK (markup_type IS NULL OR markup_type IN ('AMOUNT','PERCENT')),
    CONSTRAINT chk_batch_markup_value             CHECK (markup_value >= 0)
);

CREATE TABLE IF NOT EXISTS public.stock_movements (
    id             bigserial     PRIMARY KEY,
    product_id     integer       NOT NULL,
    batch_id       bigint,
    movement_type  varchar(16)   NOT NULL,
    qty_change     numeric(14,3) NOT NULL,
    unit_cost      numeric(14,2) NOT NULL DEFAULT 0,
    reference_type varchar(24)   NOT NULL DEFAULT 'MANUAL',
    reference_id   bigint,
    note           text,
    created_by     integer,
    created_at     timestamptz   NOT NULL DEFAULT now(),
    condition      varchar(10)   NOT NULL DEFAULT 'GOOD',
    CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN ('IN','OUT','ADJUSTMENT')),
    CONSTRAINT stock_movements_qty_change_check     CHECK (qty_change <> 0),
    CONSTRAINT stock_movements_unit_cost_check     CHECK (unit_cost >= 0),
    CONSTRAINT chk_movement_sign                   CHECK (
        (movement_type = 'IN'        AND qty_change > 0) OR
        (movement_type = 'OUT'       AND qty_change < 0) OR
        (movement_type = 'ADJUSTMENT')
    ),
    CONSTRAINT chk_stock_movement_condition        CHECK (condition IN ('GOOD','RUSAK'))
);

CREATE TABLE IF NOT EXISTS public.stock_opname_items (
    id                 bigserial     PRIMARY KEY,
    opname_id          bigint        NOT NULL,
    product_id         integer       NOT NULL,
    batch_id           bigint,
    system_qty         numeric(14,3) NOT NULL,
    physical_qty       numeric(14,3) NOT NULL,
    note               text,
    difference          numeric(14,3) GENERATED ALWAYS AS (physical_qty - system_qty) STORED,
    physical_qty_damaged numeric(14,3),
    cause              varchar(12),
    system_qty_damaged numeric(14,3) NOT NULL DEFAULT 0,
    damaged_difference numeric(14,3) GENERATED ALWAYS AS (COALESCE(physical_qty_damaged, system_qty_damaged) - system_qty_damaged) STORED,
    CONSTRAINT stock_opname_items_system_qty_check  CHECK (system_qty >= 0),
    CONSTRAINT stock_opname_items_physical_qty_check CHECK (physical_qty >= 0),
    CONSTRAINT chk_opname_item_physical_damaged      CHECK (physical_qty_damaged IS NULL OR physical_qty_damaged >= 0),
    CONSTRAINT chk_opname_item_system_damaged        CHECK (system_qty_damaged >= 0),
    CONSTRAINT chk_opname_item_cause                 CHECK (cause IS NULL OR cause IN ('RUSAK','HILANG','SALAH_HITUNG','LAIN')),
    CONSTRAINT uq_opname_item                         UNIQUE (opname_id, product_id, batch_id)
);

CREATE TABLE IF NOT EXISTS public.stock_opnames (
    id          bigserial     PRIMARY KEY,
    opname_no   varchar(32)   NOT NULL UNIQUE,
    opname_date date          NOT NULL DEFAULT CURRENT_DATE,
    note        text,
    created_by  integer,
    created_at  timestamptz   NOT NULL DEFAULT now()
);

-- Single row (id=1) + entitlement subscription per modul (plan §D8).
CREATE TABLE IF NOT EXISTS public.store_profile (
    id             integer       PRIMARY KEY DEFAULT 1,
    name           varchar(150)  NOT NULL DEFAULT 'Toko Saya',
    address        text,
    phone          varchar(30),
    email          varchar(100),
    npwp           varchar(40),
    receipt_footer text,
    logo_url       text,
    updated_at     timestamptz   NOT NULL DEFAULT now(),
    updated_by     integer,
    modules        jsonb         NOT NULL DEFAULT '{}'::jsonb,
    trial_ends_at  timestamptz,
    suspended_at   timestamptz,
    account_status varchar(16)   NOT NULL DEFAULT 'TRIAL',
    CONSTRAINT chk_store_single_row    CHECK (id = 1),
    CONSTRAINT chk_store_account_status CHECK (account_status IN ('TRIAL','ACTIVE','EXPIRED','SUSPENDED'))
);

CREATE TABLE IF NOT EXISTS public.supplier_return_items (
    id         bigserial     PRIMARY KEY,
    return_id  bigint        NOT NULL,
    product_id integer       NOT NULL,
    batch_id   bigint,
    qty        numeric(14,3) NOT NULL,
    unit_cost  numeric(14,2) NOT NULL,
    condition  varchar(10)   NOT NULL DEFAULT 'RUSAK',
    CONSTRAINT supplier_return_items_qty_check       CHECK (qty > 0),
    CONSTRAINT supplier_return_items_unit_cost_check CHECK (unit_cost >= 0),
    CONSTRAINT chk_supplier_return_item_condition   CHECK (condition IN ('GOOD','RUSAK'))
);

CREATE TABLE IF NOT EXISTS public.supplier_returns (
    id                 bigserial     PRIMARY KEY,
    return_no          text          NOT NULL UNIQUE,
    supplier_name      text          NOT NULL,
    status             varchar(12)   NOT NULL DEFAULT 'PENDING',
    total_cost         numeric(14,2) NOT NULL DEFAULT 0,
    refunded_amount    numeric(14,2),
    refunded_method_id integer,
    refunded_at        timestamptz,
    settled_by         integer,
    note               text,
    created_by         integer,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    refund_reference_no text,
    is_test            boolean       NOT NULL DEFAULT false,
    CONSTRAINT chk_supplier_return_status CHECK (status IN ('PENDING','REFUNDED','WRITTEN_OFF'))
);
`;

/* ------------------------------------------------------------------ *
 * 4) FOREIGN KEY (40) — dijaga `IF NOT EXISTS` supaya migration idempotent
 * ------------------------------------------------------------------ */
type ForeignKey = readonly [table: string, name: string, definition: string];

const FOREIGN_KEYS: readonly ForeignKey[] = [
  ['cash_sessions', 'cash_sessions_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES public.user_account(id)'],
  ['operational_expenses', 'operational_expenses_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES public.user_account(id)'],
  ['operational_expenses', 'operational_expenses_supplier_return_id_fkey', 'FOREIGN KEY (supplier_return_id) REFERENCES public.supplier_returns(id) ON DELETE RESTRICT'],
  ['order_book_items', 'order_book_items_order_book_id_fkey', 'FOREIGN KEY (order_book_id) REFERENCES public.order_books(id) ON DELETE RESTRICT'],
  ['order_book_items', 'order_book_items_product_id_fkey', 'FOREIGN KEY (product_id) REFERENCES public.product(id)'],
  ['order_books', 'order_books_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES public.user_account(id)'],
  ['order_books', 'order_books_customer_id_fkey', 'FOREIGN KEY (customer_id) REFERENCES public.customer(id)'],
  ['order_books', 'order_books_processed_by_fkey', 'FOREIGN KEY (processed_by) REFERENCES public.user_account(id)'],
  ['order_books', 'order_books_sale_id_fkey', 'FOREIGN KEY (sale_id) REFERENCES public.sales(id)'],
  ['payments', 'payments_method_id_fkey', 'FOREIGN KEY (method_id) REFERENCES public.payment_methods(id) ON DELETE RESTRICT'],
  ['payments', 'payments_received_by_fkey', 'FOREIGN KEY (received_by) REFERENCES public.user_account(id)'],
  ['payments', 'payments_sale_id_fkey', 'FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT'],
  ['product', 'product_product_category_fk', 'FOREIGN KEY (category_id) REFERENCES public.product_category(id)'],
  ['product_category', 'product_category_product_type_fk', 'FOREIGN KEY (id_type) REFERENCES public.product_type(id)'],
  ['refresh_tokens', 'refresh_tokens_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES public.user_account(id) ON DELETE CASCADE'],
  ['refund_items', 'refund_items_refund_id_fkey', 'FOREIGN KEY (refund_id) REFERENCES public.refunds(id) ON DELETE RESTRICT'],
  ['refund_items', 'refund_items_sale_item_id_fkey', 'FOREIGN KEY (sale_item_id) REFERENCES public.sale_items(id) ON DELETE RESTRICT'],
  ['refunds', 'refunds_method_id_fkey', 'FOREIGN KEY (method_id) REFERENCES public.payment_methods(id) ON DELETE RESTRICT'],
  ['refunds', 'refunds_refunded_by_fkey', 'FOREIGN KEY (refunded_by) REFERENCES public.user_account(id)'],
  ['refunds', 'refunds_sale_id_fkey', 'FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT'],
  ['sale_items', 'sale_items_batch_id_fkey', 'FOREIGN KEY (batch_id) REFERENCES public.stock_batches(id)'],
  ['sale_items', 'sale_items_product_id_fkey', 'FOREIGN KEY (product_id) REFERENCES public.product(id)'],
  ['sale_items', 'sale_items_sale_id_fkey', 'FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE'],
  ['sales', 'sales_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES public.user_account(id)'],
  ['sales', 'sales_customer_id_fkey', 'FOREIGN KEY (customer_id) REFERENCES public.customer(id)'],
  ['sales', 'sales_voided_by_fkey', 'FOREIGN KEY (voided_by) REFERENCES public.user_account(id)'],
  ['stock_batches', 'stock_batches_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES public.user_account(id)'],
  ['stock_batches', 'stock_batches_product_id_fkey', 'FOREIGN KEY (product_id) REFERENCES public.product(id)'],
  ['stock_movements', 'stock_movements_batch_id_fkey', 'FOREIGN KEY (batch_id) REFERENCES public.stock_batches(id)'],
  ['stock_movements', 'stock_movements_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES public.user_account(id)'],
  ['stock_movements', 'stock_movements_product_id_fkey', 'FOREIGN KEY (product_id) REFERENCES public.product(id)'],
  ['stock_opname_items', 'stock_opname_items_batch_id_fkey', 'FOREIGN KEY (batch_id) REFERENCES public.stock_batches(id)'],
  ['stock_opname_items', 'stock_opname_items_opname_id_fkey', 'FOREIGN KEY (opname_id) REFERENCES public.stock_opnames(id) ON DELETE CASCADE'],
  ['stock_opname_items', 'stock_opname_items_product_id_fkey', 'FOREIGN KEY (product_id) REFERENCES public.product(id)'],
  ['stock_opnames', 'stock_opnames_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES public.user_account(id)'],
  ['store_profile', 'store_profile_updated_by_fkey', 'FOREIGN KEY (updated_by) REFERENCES public.user_account(id)'],
  ['supplier_return_items', 'supplier_return_items_batch_id_fkey', 'FOREIGN KEY (batch_id) REFERENCES public.stock_batches(id) ON DELETE RESTRICT'],
  ['supplier_return_items', 'supplier_return_items_product_id_fkey', 'FOREIGN KEY (product_id) REFERENCES public.product(id) ON DELETE RESTRICT'],
  ['supplier_return_items', 'supplier_return_items_return_id_fkey', 'FOREIGN KEY (return_id) REFERENCES public.supplier_returns(id) ON DELETE RESTRICT'],
  ['supplier_returns', 'supplier_returns_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES public.user_account(id)'],
  ['supplier_returns', 'supplier_returns_refunded_method_id_fkey', 'FOREIGN KEY (refunded_method_id) REFERENCES public.payment_methods(id) ON DELETE RESTRICT'],
  ['supplier_returns', 'supplier_returns_settled_by_fkey', 'FOREIGN KEY (settled_by) REFERENCES public.user_account(id)'],
];

/* ------------------------------------------------------------------ *
 * 5) INDEX (termasuk partial unique uq_product_sku/uq_product_barcode)
 * ------------------------------------------------------------------ */
const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_cash_sessions_user                  ON public.cash_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_status                ON public.cash_sessions (status);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at         ON public.idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS idx_opex_date                           ON public.operational_expenses (expense_date);
CREATE INDEX IF NOT EXISTS idx_opex_category                       ON public.operational_expenses (category);
CREATE INDEX IF NOT EXISTS idx_opex_is_test                        ON public.operational_expenses (is_test);
CREATE INDEX IF NOT EXISTS idx_opex_supplier_return                ON public.operational_expenses (supplier_return_id);
CREATE INDEX IF NOT EXISTS idx_opname_items_opname                 ON public.stock_opname_items (opname_id);
CREATE INDEX IF NOT EXISTS idx_opname_items_product                ON public.stock_opname_items (product_id);
CREATE INDEX IF NOT EXISTS idx_opname_items_cause                  ON public.stock_opname_items (cause);
CREATE INDEX IF NOT EXISTS idx_order_books_status_created          ON public.order_books (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_books_customer                ON public.order_books (customer_id);
CREATE INDEX IF NOT EXISTS idx_order_books_sale                    ON public.order_books (sale_id);
CREATE INDEX IF NOT EXISTS idx_order_book_items_order              ON public.order_book_items (order_book_id);
CREATE INDEX IF NOT EXISTS idx_order_book_items_product            ON public.order_book_items (product_id);
CREATE INDEX IF NOT EXISTS idx_payments_sale                       ON public.payments (sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_method                     ON public.payments (method_id);
CREATE INDEX IF NOT EXISTS idx_payments_paid_at                    ON public.payments (paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_category                    ON public.product (category_id);
CREATE INDEX IF NOT EXISTS idx_product_attributes                  ON public.product USING gin (attributes);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_barcode               ON public.product (barcode) WHERE (barcode IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_sku                    ON public.product (sku) WHERE (sku IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user                 ON public.refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refunds_sale                        ON public.refunds (sale_id);
CREATE INDEX IF NOT EXISTS idx_refund_items_refund                 ON public.refund_items (refund_id);
CREATE INDEX IF NOT EXISTS idx_refund_items_sale_item              ON public.refund_items (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale                     ON public.sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product                  ON public.sale_items (product_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_batch                    ON public.sale_items (batch_id);
CREATE INDEX IF NOT EXISTS idx_sales_date                          ON public.sales (sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer                      ON public.sales (customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_is_test                       ON public.sales (is_test);
CREATE INDEX IF NOT EXISTS idx_stock_batches_product_expiry        ON public.stock_batches (product_id, expired_date);
CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry                ON public.stock_batches (expired_date);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_time        ON public.stock_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_batch               ON public.stock_movements (batch_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_reference           ON public.stock_movements (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_stock_opnames_date                  ON public.stock_opnames (opname_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_status             ON public.supplier_returns (status, id DESC);
-- Partial: pnlReport hanya butuh retur produksi berstatus REFUNDED -> baris uji
-- (is_test) tidak ikut occupy index.
CREATE INDEX IF NOT EXISTS idx_supplier_returns_is_test            ON public.supplier_returns (refunded_at)
    WHERE is_test = false AND status = 'REFUNDED';
CREATE INDEX IF NOT EXISTS idx_supplier_return_items_return        ON public.supplier_return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_supplier_return_items_batch         ON public.supplier_return_items (batch_id);
`;

/* ------------------------------------------------------------------ *
 * 6) 11 TRIGGER penjaga (D3 — tetap di DB)
 * ------------------------------------------------------------------ */
const TRIGGERS_SQL = `
DROP TRIGGER IF EXISTS trg_batch_update_product_cost ON public.stock_batches;
CREATE TRIGGER trg_batch_update_product_cost
    AFTER INSERT OR UPDATE OF unit_cost, markup_type, markup_value ON public.stock_batches
    FOR EACH ROW EXECUTE FUNCTION public.fn_batch_update_product_cost();

DROP TRIGGER IF EXISTS trg_payments_validate ON public.payments;
CREATE TRIGGER trg_payments_validate
    BEFORE INSERT OR UPDATE ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.fn_payments_validate();

DROP TRIGGER IF EXISTS trg_payments_sync_status ON public.payments;
CREATE TRIGGER trg_payments_sync_status
    AFTER INSERT OR DELETE OR UPDATE ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.fn_payments_sync_status();

DROP TRIGGER IF EXISTS trg_sale_item_validate ON public.sale_items;
CREATE TRIGGER trg_sale_item_validate
    BEFORE INSERT ON public.sale_items
    FOR EACH ROW EXECUTE FUNCTION public.fn_sale_item_validate();

DROP TRIGGER IF EXISTS trg_sale_item_guard ON public.sale_items;
CREATE TRIGGER trg_sale_item_guard
    BEFORE DELETE OR UPDATE ON public.sale_items
    FOR EACH ROW EXECUTE FUNCTION public.fn_sale_item_guard();

DROP TRIGGER IF EXISTS trg_sale_item_apply_movement ON public.sale_items;
CREATE TRIGGER trg_sale_item_apply_movement
    AFTER INSERT ON public.sale_items
    FOR EACH ROW EXECUTE FUNCTION public.fn_sale_item_apply_movement();

DROP TRIGGER IF EXISTS trg_sales_void ON public.sales;
CREATE TRIGGER trg_sales_void
    BEFORE UPDATE OF status ON public.sales
    FOR EACH ROW EXECUTE FUNCTION public.fn_sales_void();

DROP TRIGGER IF EXISTS trg_sales_void_apply ON public.sales;
CREATE TRIGGER trg_sales_void_apply
    AFTER UPDATE OF status ON public.sales
    FOR EACH ROW
    WHEN (OLD.status = 'COMPLETED' AND NEW.status IN ('VOIDED','RETURNED'))
    EXECUTE FUNCTION public.fn_sales_void_apply();

DROP TRIGGER IF EXISTS trg_sales_no_delete ON public.sales;
CREATE TRIGGER trg_sales_no_delete
    BEFORE DELETE ON public.sales
    FOR EACH ROW EXECUTE FUNCTION public.fn_sales_no_delete();

DROP TRIGGER IF EXISTS trg_stock_movement_apply ON public.stock_movements;
CREATE TRIGGER trg_stock_movement_apply
    AFTER INSERT ON public.stock_movements
    FOR EACH ROW EXECUTE FUNCTION public.fn_stock_movement_apply();

DROP TRIGGER IF EXISTS trg_stock_movement_immutable ON public.stock_movements;
CREATE TRIGGER trg_stock_movement_immutable
    BEFORE DELETE OR UPDATE ON public.stock_movements
    FOR EACH ROW EXECUTE FUNCTION public.fn_stock_movement_immutable();
`;

/* ------------------------------------------------------------------ *
 * 7) Baris default profil toko (single row id=1)
 * ------------------------------------------------------------------ */
const STORE_SEED_SQL = `
INSERT INTO public.store_profile (id, name) VALUES (1, 'Toko Saya') ON CONFLICT (id) DO NOTHING;
`;

/** Urutan drop untuk `down()` (reverse-FK). */
const DROP_TABLES_SQL = `
DROP TABLE IF EXISTS public.order_book_items;
DROP TABLE IF EXISTS public.order_books;
DROP TABLE IF EXISTS public.stock_opname_items;
DROP TABLE IF EXISTS public.stock_opnames;
-- refund_items dulu: satu-satunya tabel yang FK-nya ke refunds DAN sale_items,
-- jadi harus turun sebelum keduanya.
DROP TABLE IF EXISTS public.refund_items;
DROP TABLE IF EXISTS public.sale_items;
DROP TABLE IF EXISTS public.refunds;
DROP TABLE IF EXISTS public.payments;
DROP TABLE IF EXISTS public.supplier_return_items;
-- opex menunjuk supplier_returns (FK) -> opex harus turun lebih dulu.
DROP TABLE IF EXISTS public.operational_expenses;
DROP TABLE IF EXISTS public.supplier_returns;
DROP TABLE IF EXISTS public.cash_sessions;
DROP TABLE IF EXISTS public.refresh_tokens;
DROP TABLE IF EXISTS public.stock_movements;
DROP TABLE IF EXISTS public.stock_batches;
DROP TABLE IF EXISTS public.sales;
DROP TABLE IF EXISTS public.payment_methods;
DROP TABLE IF EXISTS public.product;
DROP TABLE IF EXISTS public.product_category;
DROP TABLE IF EXISTS public.product_type;
DROP TABLE IF EXISTS public.store_profile;
DROP TABLE IF EXISTS public.idempotency_keys;
DROP TABLE IF EXISTS public.customer;
DROP TABLE IF EXISTS public.user_account;
`;

const DROP_SEQUENCES_SQL = `
DROP SEQUENCE IF EXISTS public.sale_no_seq;
DROP SEQUENCE IF EXISTS public.batch_code_seq;
DROP SEQUENCE IF EXISTS public.opname_no_seq;
DROP SEQUENCE IF EXISTS public.supplier_return_no_seq;
DROP SEQUENCE IF EXISTS public.order_no_seq;
`;

const DROP_FUNCTIONS_SQL = `
DROP FUNCTION IF EXISTS public.fn_batch_update_product_cost() CASCADE;
DROP FUNCTION IF EXISTS public.fn_payments_sync_status() CASCADE;
DROP FUNCTION IF EXISTS public.fn_payments_validate() CASCADE;
DROP FUNCTION IF EXISTS public.fn_sale_item_apply_movement() CASCADE;
DROP FUNCTION IF EXISTS public.fn_sale_item_guard() CASCADE;
DROP FUNCTION IF EXISTS public.fn_sale_item_validate() CASCADE;
DROP FUNCTION IF EXISTS public.fn_sales_no_delete() CASCADE;
DROP FUNCTION IF EXISTS public.fn_sales_void() CASCADE;
DROP FUNCTION IF EXISTS public.fn_sales_void_apply() CASCADE;
DROP FUNCTION IF EXISTS public.fn_stock_movement_apply() CASCADE;
DROP FUNCTION IF EXISTS public.fn_stock_movement_immutable() CASCADE;
`;

/** Nilai string konstanta internal -> literal SQL (tidak ada input user). */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function addForeignKeys(context: Sequelize, transaction: Transaction): Promise<void> {
  for (const [table, name, definition] of FOREIGN_KEYS) {
    await context.query(
      `DO $fk$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint
            WHERE conname = ${sqlText(name)} AND conrelid = ${sqlText(`public.${table}`)}::regclass
         ) THEN
           EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I ${definition}', ${sqlText(table)}, ${sqlText(name)});
         END IF;
       END
       $fk$;`,
      { transaction },
    );
  }
}

export const up: Migration['up'] = async ({ context }) => {
  await context.transaction(async (transaction) => {
    await context.query(FUNCTIONS_SQL, { transaction });
    await context.query(SEQUENCES_SQL, { transaction });
    await context.query(TABLES_SQL, { transaction });
    await addForeignKeys(context, transaction);
    await context.query(INDEXES_SQL, { transaction });
    await context.query(TRIGGERS_SQL, { transaction });
    await context.query(STORE_SEED_SQL, { transaction });
  });
};

export const down: Migration['down'] = async ({ context }) => {
  await context.transaction(async (transaction) => {
    await context.query(DROP_TABLES_SQL, { transaction });
    await context.query(DROP_SEQUENCES_SQL, { transaction });
    await context.query(DROP_FUNCTIONS_SQL, { transaction });
  });
};