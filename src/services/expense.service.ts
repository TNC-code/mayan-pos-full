import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { withTx } from '../utils/tx.js';

export interface ExpenseRow {
  id: number;
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

const SELECT_EXPENSE = `
  SELECT e.id, e.expense_date, e.category, e.description, e.amount,
         e.created_by, u.username AS created_by_name, e.created_at, e.updated_at,
         e.source, e.supplier_return_id, e.is_test
    FROM operational_expenses e
    LEFT JOIN user_account u ON u.id = e.created_by
`;

export async function listExpenses(params: {
  month?: string;
  category?: string;
  include_test?: boolean;
  limit: number;
  offset: number;
}): Promise<ExpenseRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];

  // Default: opex dari skrip uji tidak ikut daftar produksi (padanan sales.is_test).
  if (!params.include_test) {
    where.push('e.is_test = false');
  }
  if (params.month) {
    args.push(params.month);
    where.push(`to_char(e.expense_date, 'YYYY-MM') = $${args.length}`);
  }
  if (params.category) {
    args.push(params.category.toUpperCase());
    where.push(`e.category = $${args.length}`);
  }

  args.push(params.limit, params.offset);
  const res = await pool.query<ExpenseRow>(
    `${SELECT_EXPENSE} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.expense_date DESC, e.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}

export async function getExpense(id: number, client: PoolClient | null = null): Promise<ExpenseRow> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);
  const res = await runner<ExpenseRow>(`${SELECT_EXPENSE} WHERE e.id = $1`, [id]);
  if (!res.rows[0]) throw new ApiError('EXPENSE_NOT_FOUND', `Pengeluaran id=${id} tidak ditemukan`);
  return res.rows[0];
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
  return withTx(async (client) => {
    const res = await client.query<{ id: number }>(
      `INSERT INTO operational_expenses (expense_date, category, description, amount, created_by, is_test)
       VALUES (COALESCE($1::date, CURRENT_DATE), UPPER($2), $3, $4, $5, COALESCE($6, false)) RETURNING id`,
      [
        input.expense_date ?? null,
        input.category.trim(),
        input.description ?? null,
        input.amount,
        createdBy,
        input.is_test ?? null,
      ],
    );
    return getExpense(res.rows[0]!.id, client);
  }, 'expense-create');
}

/** Owner boleh mengoreksi (input dan update). Kategori dinormalisasi UPPERCASE. */
export async function updateExpense(id: number, input: Partial<ExpenseInput>): Promise<ExpenseRow> {
  return withTx(async (client) => {
    const cur = await client.query<{ id: number }>(
      'SELECT id FROM operational_expenses WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!cur.rows[0]) throw new ApiError('EXPENSE_NOT_FOUND', `Pengeluaran id=${id} tidak ditemukan`);

    const sets: string[] = [];
    const args: unknown[] = [];
    if (input.expense_date !== undefined) {
      args.push(input.expense_date);
      sets.push(`expense_date = $${args.length}::date`);
    }
    if (input.category !== undefined) {
      args.push(input.category.trim().toUpperCase());
      sets.push(`category = $${args.length}`);
    }
    if (input.description !== undefined) {
      args.push(input.description);
      sets.push(`description = $${args.length}`);
    }
    if (input.amount !== undefined) {
      args.push(input.amount);
      sets.push(`amount = $${args.length}`);
    }
    if (input.is_test !== undefined) {
      args.push(input.is_test);
      sets.push(`is_test = $${args.length}`);
    }
    if (sets.length === 0) return getExpense(id, client);

    args.push(new Date());
    sets.push(`updated_at = $${args.length}`);
    args.push(id);
    await client.query(`UPDATE operational_expenses SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
    return getExpense(id, client);
  }, 'expense-update');
}

/** Kategori opex otomatis ketika distributor menolak barang rusak yang diretur. */
export const WRITEOFF_CATEGORY = 'BARANG_RUSAK';

/**
 * Catat opex write-off barang rusak yang ditolak distributor (UC-B, settle WRITTEN_OFF).
 * WAJIB dipanggil di transaksi yang sama dengan settle supaya retur + opex bersifat atomik
 * (gagal di tengah -> tidak ada opex yatim tanpa retur).
 * `expense_date` memakai tanggal bisnis (TZ aplikasi), bukan CURRENT_DATE server yang UTC.
 * `is_test` diteruskan dari context pemanggil (opsional) supaya retur uji tidak masuk P&L.
 */
export async function recordWriteOffExpense(
  client: PoolClient,
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

  const res = await client.query<{ id: number }>(
    `INSERT INTO operational_expenses
       (expense_date, category, description, amount, created_by, source, supplier_return_id, is_test)
     VALUES ((now() AT TIME ZONE $1)::date, $2, $3, $4, $5, 'SUPPLIER_RETURN', $6, COALESCE($7, false))
     RETURNING id`,
    [
      env.businessTz,
      WRITEOFF_CATEGORY,
      description.slice(0, 500),
      input.amount,
      input.created_by,
      input.supplier_return_id,
      input.is_test ?? null,
    ],
  );

  return getExpense(res.rows[0]!.id, client);
}

/** Opex otomatis yang menempel pada satu retur distributor (dipakai detail retur). */
export async function getWriteOffExpense(
  client: PoolClient | null,
  supplierReturnId: number,
): Promise<ExpenseRow | null> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);
  const res = await runner<ExpenseRow>(
    `${SELECT_EXPENSE} WHERE e.supplier_return_id = $1 ORDER BY e.id ASC LIMIT 1`,
    [supplierReturnId],
  );
  return res.rows[0] ?? null;
}
