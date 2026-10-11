import { ApiError, notFound } from '../utils/errors.js';
import { mapOrmError } from '../utils/orm-errors.js';
import { PaymentMethod } from '../models/index.js';

/**
 * Metode pembayaran di atas Sequelize (MP-2).
 *
 * Paritas dengan versi raw SQL lama (`git show HEAD~1:src/services/payment-method.service.ts`):
 *  - list: urutan `sort_order ASC, name ASC`; `active_only=true` hanya yang aktif;
 *  - create: `code` dinormalisasi (trim + upper) lalu diperiksa formatnya,
 *    default `is_active=true`, `requires_reference=false`, `sort_order=100`
 *    (SQL lama memakai `COALESCE(..., 100)`, TIDAK default kolom 0);
 *  - `code` kembar -> `DUPLICATE` 409 lewat SQLSTATE 23505 (`mapOrmError`);
 *  - patch kosong -> `VALIDATION_ERROR` "Tidak ada kolom yang akan diubah";
 *  - id tak ada -> `NOT_FOUND` 404 ("Metode pembayaran id=… tidak ditemukan");
 *  - `updated_at` selalu disentuh saat update (parity `updated_at = now()`).
 *
 * Default scope model menyembunyikan metode nonaktif; daftar utuh (menu
 * "set payment method" harus tetap menampilkan yang nonaktif) karena itu selalu
 * lewat `.scope('withInactive')`.
 */

/** Bentuk row sesuai kontrak API lama (timestamp = ISO string di JSON). */
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

function toPaymentMethodRow(row: PaymentMethod): PaymentMethodRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    is_active: row.is_active,
    requires_reference: row.requires_reference,
    bank_name: row.bank_name,
    account_no: row.account_no,
    account_name: row.account_name,
    notes: row.notes,
    sort_order: row.sort_order,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** GET semua metode (menu). activeOnly=true -> hanya yang bisa dipakai. */
export async function listPaymentMethods(activeOnly = false): Promise<PaymentMethodRow[]> {
  const rows = await PaymentMethod.scope('withInactive').findAll({
    where: activeOnly ? { is_active: true } : undefined,
    order: [
      ['sort_order', 'ASC'],
      ['name', 'ASC'],
    ],
  });
  return rows.map(toPaymentMethodRow);
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
  try {
    const created = await PaymentMethod.create({
      code,
      name: input.name,
      is_active: input.is_active ?? true,
      requires_reference: input.requires_reference ?? false,
      bank_name: input.bank_name ?? null,
      account_no: input.account_no ?? null,
      account_name: input.account_name ?? null,
      notes: input.notes ?? null,
      // Default 100 (bukan 0) mengikuti COALESCE SQL lama supaya metode baru
      // mengambang di belakang metode bawaan seed.
      sort_order: input.sort_order ?? 100,
    });
    return toPaymentMethodRow(created);
  } catch (err) {
    // code kembar -> UNIQUE payment_methods_code_key (23505) -> DUPLICATE 409.
    throw mapOrmError(err);
  }
}

export async function getPaymentMethod(id: number): Promise<PaymentMethodRow> {
  const row = await PaymentMethod.scope('withInactive').findByPk(id);
  if (!row) throw notFound(`Metode pembayaran id=${id} tidak ditemukan`);
  return toPaymentMethodRow(row);
}

/** Ubah / aktif-nonaktifkan / set rekening bank (menu "set payment method"). */
export async function updatePaymentMethod(
  id: number,
  patch: Partial<PaymentMethodInput>,
): Promise<PaymentMethodRow> {
  const values: Record<string, unknown> = {};
  if (patch.code !== undefined) values.code = patch.code.trim().toUpperCase();
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.is_active !== undefined) values.is_active = patch.is_active;
  if (patch.requires_reference !== undefined) values.requires_reference = patch.requires_reference;
  if (patch.bank_name !== undefined) values.bank_name = patch.bank_name;
  if (patch.account_no !== undefined) values.account_no = patch.account_no;
  if (patch.account_name !== undefined) values.account_name = patch.account_name;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.sort_order !== undefined) values.sort_order = patch.sort_order;

  if (Object.keys(values).length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');
  }

  // `updated_at` disentuh Sequelize otomatis karena model memakai timestamps.
  const row = await PaymentMethod.scope('withInactive').findByPk(id);
  if (!row) throw notFound(`Metode pembayaran id=${id} tidak ditemukan`);
  try {
    await row.update(values);
  } catch (err) {
    // code kembar saat patch -> 409 DUPLICATE (parity dengan jalur raw SQL lama).
    throw mapOrmError(err);
  }
  return getPaymentMethod(id);
}
