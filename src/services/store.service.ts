import { ApiError } from '../utils/errors.js';
import { withRetry } from '../utils/tx.js';
import { StoreProfile, sequelize, type AccountStatus, type StoreModules } from '../models/index.js';
import { getSale } from './sale.service.js';

/**
 * Profil toko di atas Sequelize (MP-2) + nota/`saleReceipt`.
 *
 * Paritas dengan versi raw SQL lama (`git show HEAD~1:src/services/store.service.ts`):
 *  - `getStoreProfile()` membaca satu baris `id = 1` dan mengembalikan SELURUH
 *    kolom baris itu (SQL lama `SELECT *`, termasuk kolom entitlement
 *    `modules`/`trial_ends_at`/`suspended_at`/`account_status` yang ditambahkan
 *    baseline migration) — jadi bentuk response tidak berubah sama sekali;
 *  - baris hilang -> `INTERNAL_ERROR` "Profil toko belum diinisialisasi
 *    (jalankan migrasi)";
 *  - `updateStoreProfile()`: patch semantics (hanya kolom yang dikirim),
 *    `updated_at` disentuh, `updated_by` = user pemanggil, patch kosong ->
 *    `VALIDATION_ERROR` "Tidak ada kolom yang akan diubah", dan baris dibaca
 *    kembali DI DALAM transaksi yang sama (identik dengan versi lama yang tidak
 *    bisa membaca lewat pool sebelum commit);
 *  - retry policy `fase.md` tetap lewat `withRetry` (hanya error koneksi/serialisasi).
 *
 * Catatan `saleReceipt`: dirakit tetap sama, tapi sumber `store` sekarang model
 * Sequelize sedangkan `sale` masih dibaca lewat `getSale()` yang versi raw SQL
 *-nya baru pindah di MP-4. Mengangkat `getSale()` di MP-2 berarti ikut menarik
 * modul sales ke scope MP-2, jadi keduanya sengaja dibiarkan terpisah sampai MP-4.
 */

export interface StoreProfileRow {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  npwp: string | null;
  receipt_footer: string | null;
  logo_url: string | null;
  updated_at: string;
  updated_by: number | null;
  /** Entitlement subscription per modul (gate MP-8; ikut tampil sejak baseline). */
  modules: StoreModules;
  trial_ends_at: string | null;
  suspended_at: string | null;
  account_status: AccountStatus;
}

const isoOrNull = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

function toStoreProfileRow(row: StoreProfile): StoreProfileRow {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    phone: row.phone,
    email: row.email,
    npwp: row.npwp,
    receipt_footer: row.receipt_footer,
    logo_url: row.logo_url,
    updated_at: new Date(row.updated_at).toISOString(),
    updated_by: row.updated_by,
    modules: row.modules ?? {},
    trial_ends_at: isoOrNull(row.trial_ends_at),
    suspended_at: isoOrNull(row.suspended_at),
    account_status: row.account_status,
  };
}

export async function getStoreProfile(): Promise<StoreProfileRow> {
  const row = await StoreProfile.findByPk(1);
  if (!row) {
    throw new ApiError('INTERNAL_ERROR', 'Profil toko belum diinisialisasi (jalankan migrasi)');
  }
  return toStoreProfileRow(row);
}

export interface StoreProfileInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  npwp?: string | null;
  receipt_footer?: string | null;
  logo_url?: string | null;
}

/** Update profil toko (KASIR only di route; OWNER -> 403 FORBIDDEN). */
export async function updateStoreProfile(input: StoreProfileInput, userId: number): Promise<StoreProfileRow> {
  const values: Record<string, unknown> = {};
  if (input.name !== undefined) values.name = input.name;
  if (input.address !== undefined) values.address = input.address;
  if (input.phone !== undefined) values.phone = input.phone;
  if (input.email !== undefined) values.email = input.email;
  if (input.npwp !== undefined) values.npwp = input.npwp;
  if (input.receipt_footer !== undefined) values.receipt_footer = input.receipt_footer;
  if (input.logo_url !== undefined) values.logo_url = input.logo_url;

  if (Object.keys(values).length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');
  }

  // `updated_at` disentuh Sequelize otomatis (model memakai timestamps).
  return withRetry(
    () =>
      sequelize.transaction(async (transaction) => {
        const [updated] = await StoreProfile.update(
          { ...values, updated_by: userId },
          { where: { id: 1 }, transaction },
        );
        if (updated !== 1) {
          throw new ApiError('INTERNAL_ERROR', 'Profil toko belum diinisialisasi');
        }
        // Baca baris TERBARU di transaksi yang sama (belum commit -> tak terlihat dari luar).
        const row = await StoreProfile.findByPk(1, { transaction });
        if (!row) {
          throw new ApiError('INTERNAL_ERROR', 'Profil toko belum diinisialisasi');
        }
        return toStoreProfileRow(row);
      }),
    'store-update',
  );
}

/* ====================== NOTA / RECEIPT (JSON untuk frontend) ====================== */

export interface Receipt {
  store: StoreProfileRow;
  sale: {
    sale_no: string;
    sale_date: string;
    status: string;
    payment_status: string;
    cashier: string | null;
    customer: string | null;
    customer_address: string | null;
    note: string | null;
  };
  items: Array<{
    name: string;
    qty: number;
    unit: string | null;
    unit_price: number;
    subtotal: number;
    note: string | null;
  }>;
  totals: {
    subtotal: number;
    tax_amount: number;
    total_amount: number;
    paid_amount: number;
    refunded_amount: number;
    due_amount: number;
    change_total: number;
  };
  payments: Array<{
    method: string;
    amount: number;
    tendered_amount: number | null;
    change_amount: number | null;
    reference_no: string | null;
    paid_at: string;
  }>;
  refunds: Array<{
    method: string | null;
    amount: number;
    reason: string;
    refunded_at: string;
  }>;
  footer: string | null;
}

/**
 * Nota lengkap dalam SATU JSON — frontend tinggal render/print (thermal 58/80mm).
 * Sumber: store_profile (header/footer) + detail sale (items, payments, refunds, totals).
 */
export async function saleReceipt(saleId: number): Promise<Receipt> {
  const [store, sale] = await Promise.all([getStoreProfile(), getSale(saleId)]);

  const changeTotal = sale.payments.reduce((acc, p) => acc + Number(p.change_amount ?? 0), 0);

  return {
    store,
    sale: {
      sale_no: sale.sale_no,
      sale_date: sale.sale_date,
      status: sale.status,
      payment_status: sale.payment_status,
      cashier: sale.created_by_name,
      customer: sale.customer_name,
      customer_address: sale.customer_address,
      note: sale.note,
    },
    items: sale.items.map((it) => ({
      name: it.product_name ?? `#${it.product_id}`,
      qty: Number(it.qty),
      unit: it.unit,
      unit_price: Number(it.unit_price),
      subtotal: Number(it.subtotal),
      note: it.note,
    })),
    totals: {
      subtotal: Number((sale.total_amount - sale.tax_amount).toFixed(2)),
      tax_amount: Number(sale.tax_amount),
      total_amount: Number(sale.total_amount),
      paid_amount: sale.paid_amount ?? 0,
      refunded_amount: sale.refunded_amount ?? 0,
      due_amount: sale.due_amount ?? 0,
      change_total: changeTotal,
    },
    payments: sale.payments.map((p) => ({
      method: p.method_name,
      amount: Number(p.amount),
      tendered_amount: p.tendered_amount === null ? null : Number(p.tendered_amount),
      change_amount: p.change_amount === null ? null : Number(p.change_amount),
      reference_no: p.reference_no,
      paid_at: p.paid_at,
    })),
    refunds: sale.refunds.map((r) => ({
      method: r.method_code,
      amount: Number(r.amount),
      reason: r.reason,
      refunded_at: r.refunded_at,
    })),
    footer: store.receipt_footer,
  };
}
