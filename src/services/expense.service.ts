import { Op, Sequelize, type Includeable, type Transaction } from 'sequelize';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { withOrmTx } from '../utils/tx.js';
import { mapOrmError } from '../utils/orm-errors.js';
import { isoDateOnly } from '../utils/dates.js';
import { OperationalExpense, UserAccount } from '../models/index.js';

/**
 * Opex operasional di atas Sequelize (MP-6).
 *
 * Paritas penuh dengan versi raw SQL lama
 * (`git show e33b3b5:src/services/expense.service.ts`): bentuk response
 * `ExpenseRow`, urutan list (`expense_date DESC, id DESC`), normalisasi kategori
 * (UPPERCASE + underscore dari zod), `is_test` disembunyikan default, dan —
 * yang paling penting — `recordWriteOffExpense` yang WAJIB dipanggil di dalam
 * transaksi settle retur distributor (`supplier-return.service.ts`) supaya
 * retur + opex bersifat atomik.
 *
 * Yang tetap milik DB: CHECK `chk_opex_amount_positive` (amount > 0),
 * DEFAULT `CURRENT_DATE` untuk `expense_date`, FK `supplier_return_id`, dan
 * `updated_at` yang di-`touch` setiap koreksi.
 *
 * RBAC TIDAK dicek di service (sudah di route: OWNER untuk list/get/create/
 * update) — service ini murni lapisan data, seperti versi lamanya.
 */

export interface ExpenseRow {
  id: number;
  /** Bentuk wire lama: kolom `date` diserialisasi sebagai ISO (`…T00:00:00.000Z`). */
  expense_date: string;
  category: string;
  description: string | null;
  amount: number;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  /** MANUAL = diinput kasir/owner; SUPPLIER_RETURN = otomatis dari write-off retur distributor. */
  source: string;
  supplier_return_id: number | null;
  /** true = baris dari skrip uji; dikecualikan dari daftar & P&L kecuali diminta. */
  is_test: boolean;
}

const WITH_CREATOR: Includeable = {
  model: UserAccount,
  as: 'creator',
  attributes: ['id', 'username'],
  required: false,
};

const EXPENSE_INCLUDES: Includeable[] = [WITH_CREATOR];

type ExpenseWithCreator = OperationalExpense & { creator?: { id: number; username: string } | null };

function toExpenseRow(row: ExpenseWithCreator): ExpenseRow {
  return {
    id: row.id,
    expense_date: isoDateOnly(row.expense_date) as string,
    category: row.category,
    description: row.description,
    amount: row.amount,
    created_by: row.created_by,
    created_by_name: row.creator?.username ?? null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    source: row.source,
    supplier_return_id: row.supplier_return_id,
    is_test: row.is_test,
  };
}

/* ================================= daftar opex ================================= */

export interface ExpenseListQuery {
  month?: string;
  category?: string;
  include_test?: boolean;
  limit: number;
  offset: number;
}

/**
 * `GET /expenses` (OWNER). Default `id`-descending per tanggal paling baru:
 * `expense_date DESC, id DESC`. Baris `is_test = true` disembunyikan kecuali
 * `?include_test=true` (padanan `GET /sales`).
 */
export async function listExpenses(params: ExpenseListQuery): Promise<ExpenseRow[]> {
  const conditions: Record<string, unknown>[] = [];

  if (!params.include_test) conditions.push({ is_test: false });
  if (params.category) conditions.push({ category: params.category.trim().toUpperCase() });
  // `expense_date` kolom `date`: filter bulan lewat ekspresi yang sama dengan
  // versi lama (`to_char(expense_date, 'YYYY-MM') = $1`).
  if (params.month) {
    conditions.push(
      Sequelize.where(Sequelize.fn('to_char', Sequelize.col('expense_date'), 'YYYY-MM'), params.month) as never,
    );
  }

  const rows = await OperationalExpense.findAll({
    where: { [Op.and]: conditions },
    include: EXPENSE_INCLUDES,
    // Include 1:1 (belongsTo) -> jumlah baris tidak berubah, LIMIT/OFFSET aman.
    subQuery: false,
    order: [
      ['expense_date', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: params.limit,
    offset: params.offset,
  });

  return (rows as unknown as ExpenseWithCreator[]).map(toExpenseRow);
}

/* ================================= detail opex ================================= */

/** `GET /expenses/:id` — boleh dipanggil di dalam transaksi (langsung setelah create). */
export async function getExpense(id: number, transaction?: Transaction): Promise<ExpenseRow> {
  const row = await OperationalExpense.findByPk(id, { include: EXPENSE_INCLUDES, transaction });
  if (!row) throw new ApiError('EXPENSE_NOT_FOUND', `Pengeluaran id=${id} tidak ditemukan`);
  return toExpenseRow(row as unknown as ExpenseWithCreator);
}

export interface ExpenseInput {
  expense_date?: string;
  category: string;
  description?: string | null;
  amount: number;
  /** Hanya diisi oleh harness/skrip uji; default false (= opex produksi). */
  is_test?: boolean;
}

/** Pengeluaran operasional (gaji, listrik, internet, dst). Input = baca = OWNER (amandemen RBAC FE-11). */
export async function createExpense(input: ExpenseInput, createdBy: number | null): Promise<ExpenseRow> {
  try {
    return await withOrmTx(async (transaction) => {
      // `expense_date` tidak diisi -> DEFAULT `CURRENT_DATE` dievaluasi PostgreSQL
      // (padanan `COALESCE($1::date, CURRENT_DATE)` versi lama).
      const created = await OperationalExpense.create(
        {
          ...(input.expense_date ? { expense_date: input.expense_date } : {}),
          category: input.category.trim().toUpperCase(),
          description: input.description ?? null,
          amount: input.amount,
          created_by: createdBy,
          is_test: input.is_test ?? false,
        },
        { transaction },
      );
      return getExpense(created.id, transaction);
    }, 'expense-create');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/**
 * `PATCH /expenses/:id` — owner boleh mengoreksi opex yang diinput manual
 * (kategori dinormalisasi UPPERCASE, hanya field yang dikirim yang berubah).
 *
 * IMMUTABLE untuk opex turunan sistem (`source = 'SUPPLIER_RETURN'`, yaitu opex
 * write-off dari settle retur distributor): angka rugi pada pembukuan harus
 * selalu mengikuti dokumen returnnya, jadi tidak boleh diedit dari layar opex
 * (405 `IMMUTABLE_RECORD`) — memo yang sama seperti trigger
 * `trg_stock_movement_immutable` untuk ledger stok.
 */
export async function updateExpense(id: number, input: Partial<ExpenseInput>): Promise<ExpenseRow> {
  try {
    return await withOrmTx(async (transaction) => {
      const row = await OperationalExpense.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row) throw new ApiError('EXPENSE_NOT_FOUND', `Pengeluaran id=${id} tidak ditemukan`);
      if (row.source !== 'MANUAL') {
        throw new ApiError(
          'IMMUTABLE_RECORD',
          `Pengeluaran id=${id} berasal dari sistem (${row.source}) sehingga tidak bisa dikoreksi manual`,
        );
      }

      const sets: Record<string, unknown> = {};
      if (input.expense_date !== undefined) sets.expense_date = input.expense_date;
      if (input.category !== undefined) sets.category = input.category.trim().toUpperCase();
      if (input.description !== undefined) sets.description = input.description;
      if (input.amount !== undefined) sets.amount = input.amount;
      if (input.is_test !== undefined) sets.is_test = input.is_test;

      // Tidak ada field yang dikirim -> tidak ada UPDATE (parity versi lama).
      if (Object.keys(sets).length > 0) {
        await row.update({ ...sets, updated_at: new Date() }, { transaction });
      }
      return getExpense(id, transaction);
    }, 'expense-update');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* ====================== opex otomatis write-off retur distributor ====================== */

/** Kategori opex otomatis ketika distributor menolak barang rusak yang diretur. */
export const WRITEOFF_CATEGORY = 'BARANG_RUSAK';

/** Tanggal hari ini di zona waktu bisnis (bukan `CURRENT_DATE` server yang UTC). */
function businessToday(): string {
  // `en-CA` -> bentuk YYYY-MM-DD. Dipakai untuk opex write-off supaya tanggalnya
  // sama dengan `(now() AT TIME ZONE $tz)::date` versi raw SQL lama.
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.businessTz }).format(new Date());
}

/**
 * Catat opex write-off barang rusak yang ditolak distributor (UC-B, settle WRITTEN_OFF).
 * WAJIB dipanggil di transaksi yang sama dengan settle supaya retur + opex bersifat atomik
 * (gagal di tengah -> tidak ada opex yatim tanpa retur).
 * `expense_date` memakai tanggal bisnis (TZ aplikasi), bukan CURRENT_DATE server yang UTC.
 * `is_test` diteruskan dari context pemanggil (opsional) supaya retur uji tidak masuk P&L.
 */
export async function recordWriteOffExpense(
  transaction: Transaction,
  input: {
    supplier_return_id: number;
    return_no: string;
    supplier_name: string;
    amount: number;
    created_by: number | null;
    note?: string | null;
    is_test?: boolean;
  },
): Promise<ExpenseRow | null> {
  // opex di-DB CHECK (amount > 0); barang gratis (unit_cost 0) tidak mungkin jadi rugi.
  if (input.amount <= 0) return null;

  const description = [
    `Write-off retur distributor ${input.return_no} ke ${input.supplier_name}`,
    input.note?.trim() || null,
  ]
    .filter(Boolean)
    .join(' - ');

  const created = await OperationalExpense.create(
    {
      expense_date: businessToday(),
      category: WRITEOFF_CATEGORY,
      description: description.slice(0, 500),
      amount: input.amount,
      created_by: input.created_by,
      source: 'SUPPLIER_RETURN',
      supplier_return_id: input.supplier_return_id,
      is_test: input.is_test ?? false,
    },
    { transaction },
  );

  return getExpense(created.id, transaction);
}

/** Opex otomatis yang menempel pada satu retur distributor (dipakai detail retur). */
export async function getWriteOffExpense(
  transaction: Transaction | null | undefined,
  supplierReturnId: number,
): Promise<ExpenseRow | null> {
  const row = await OperationalExpense.findOne({
    where: { supplier_return_id: supplierReturnId },
    include: EXPENSE_INCLUDES,
    // `LIMIT 1` versi lama dipertahankan (FK membuat barisnya maksimal satu,
    // tapi urutan id dipakai sebagai penentu kalau ada data lama).
    order: [['id', 'ASC']],
    transaction,
  });
  return row ? toExpenseRow(row as unknown as ExpenseWithCreator) : null;
}
