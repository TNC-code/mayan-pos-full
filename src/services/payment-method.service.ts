import { pool } from '../config/db.js';
import { ApiError, notFound } from '../utils/errors.js';

export interface PaymentMethodRow {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
  requires_reference: boolean;
  bank_name: string | null;
  account_no: string | null;
  account_name: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** GET semua metode (menu). active_only=true -> hanya yang bisa dipakai. */
export async function listPaymentMethods(activeOnly = false): Promise<PaymentMethodRow[]> {
  const res = await pool.query<PaymentMethodRow>(
    `SELECT id, code, name, is_active, requires_reference, bank_name, account_no, account_name,
            notes, sort_order, created_at, updated_at
       FROM payment_methods
      ${activeOnly ? 'WHERE is_active = true' : ''}
      ORDER BY sort_order ASC, name ASC`,
  );
  return res.rows;
}

export interface PaymentMethodInput {
  code: string;
  name: string;
  is_active?: boolean;
  requires_reference?: boolean;
  bank_name?: string | null;
  account_no?: string | null;
  account_name?: string | null;
  notes?: string | null;
  sort_order?: number;
}

/** Kode yang umum dipakai; daftar ini hanya petunjuk, kode lain tetap bisa dibuat (menu configurable). */
const KNOWN_CODES = ['CASH', 'BANK_TRANSFER', 'DEBIT_CARD', 'CREDIT_CARD', 'QRIS', 'EWALLET', 'VOUCHER', 'OTHER'];
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,29}$/;

export async function createPaymentMethod(input: PaymentMethodInput): Promise<PaymentMethodRow> {
  const code = input.code.trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Code metode tidak valid: harus huruf kapital + angka/underscore (2-30 karakter). Contoh: ${KNOWN_CODES.join(', ')}`,
      { received: code },
    );
  }
  const res = await pool.query<{ id: number }>(
    `INSERT INTO payment_methods
       (code, name, is_active, requires_reference, bank_name, account_no, account_name, notes, sort_order, updated_at)
     VALUES ($1, $2, COALESCE($3, true), COALESCE($4, false), $5, $6, $7, $8, COALESCE($9, 100), now())
     RETURNING id`,
    [
      code,
      input.name,
      input.is_active ?? true,
      input.requires_reference ?? false,
      input.bank_name ?? null,
      input.account_no ?? null,
      input.account_name ?? null,
      input.notes ?? null,
      input.sort_order ?? 100,
    ],
  );
  return getPaymentMethod(res.rows[0]!.id);
}

export async function getPaymentMethod(id: number): Promise<PaymentMethodRow> {
  const res = await pool.query<PaymentMethodRow>(
    `SELECT id, code, name, is_active, requires_reference, bank_name, account_no, account_name,
            notes, sort_order, created_at, updated_at
       FROM payment_methods WHERE id = $1`,
    [id],
  );
  if (!res.rows[0]) throw notFound(`Metode pembayaran id=${id} tidak ditemukan`);
  return res.rows[0];
}

/** Ubah / aktif-nonaktifkan / set rekening bank (menu "set payment method"). */
export async function updatePaymentMethod(id: number, patch: Partial<PaymentMethodInput>): Promise<PaymentMethodRow> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };

  if (patch.code !== undefined) push('code', patch.code.trim().toUpperCase());
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.is_active !== undefined) push('is_active', patch.is_active);
  if (patch.requires_reference !== undefined) push('requires_reference', patch.requires_reference);
  if (patch.bank_name !== undefined) push('bank_name', patch.bank_name);
  if (patch.account_no !== undefined) push('account_no', patch.account_no);
  if (patch.account_name !== undefined) push('account_name', patch.account_name);
  if (patch.notes !== undefined) push('notes', patch.notes);
  if (patch.sort_order !== undefined) push('sort_order', patch.sort_order);

  if (sets.length === 0) throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');

  sets.push('updated_at = now()');
  params.push(id);

  const res = await pool.query(
    `UPDATE payment_methods SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params as never[],
  );
  if (res.rowCount === 0) throw notFound(`Metode pembayaran id=${id} tidak ditemukan`);
  return getPaymentMethod(id);
}
