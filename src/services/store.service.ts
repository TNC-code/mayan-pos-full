import { pool } from '../config/db.js';
import { ApiError } from '../utils/errors.js';
import { withTx } from '../utils/tx.js';
import { getSale } from './sale.service.js';

export interface StoreProfile {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  npwp: string | null;
  receipt_footer: string | null;
  logo_url: string | null;
  updated_at: string;
}

export async function getStoreProfile(): Promise<StoreProfile> {
  const res = await pool.query<StoreProfile>(`SELECT * FROM store_profile WHERE id = 1`);
  if (!res.rows[0]) {
    throw new ApiError('INTERNAL_ERROR', 'Profil toko belum diinisialisasi (jalankan migrasi)');
  }
  return res.rows[0];
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

/** Update profil toko (OWNER only di route). */
export async function updateStoreProfile(input: StoreProfileInput, userId: number): Promise<StoreProfile> {
  return withTx(async (client) => {
    const sets: string[] = [];
    const args: unknown[] = [];
    const push = (col: string, value: unknown) => {
      args.push(value);
      sets.push(`${col} = $${args.length}`);
    };

    if (input.name !== undefined) push('name', input.name);
    if (input.address !== undefined) push('address', input.address);
    if (input.phone !== undefined) push('phone', input.phone);
    if (input.email !== undefined) push('email', input.email);
    if (input.npwp !== undefined) push('npwp', input.npwp);
    if (input.receipt_footer !== undefined) push('receipt_footer', input.receipt_footer);
    if (input.logo_url !== undefined) push('logo_url', input.logo_url);

    if (sets.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');
    }

    sets.push('updated_at = now()');
    args.push(userId);
    const res = await client.query(
      `UPDATE store_profile SET ${sets.join(', ')}, updated_by = $${args.length} WHERE id = 1 RETURNING id`,
      args,
    );
    if (res.rowCount === 0) throw new ApiError('INTERNAL_ERROR', 'Profil toko belum diinisialisasi');

    // Baca baris TERBARU di transaksi yang sama (bukan via pool: belum commit -> tak terlihat).
    const row = await client.query<StoreProfile>(`SELECT * FROM store_profile WHERE id = 1`);
    return row.rows[0]!;
  }, 'store-update');
}

/* ====================== NOTA / RECEIPT (JSON untuk frontend) ====================== */

export interface Receipt {
  store: StoreProfile;
  sale: {
    sale_no: string;
    sale_date: string;
    status: string;
    payment_status: string;
    cashier: string | null;
    customer: string | null;
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
