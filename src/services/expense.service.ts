import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
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
}

const SELECT_EXPENSE = `
  SELECT e.id, e.expense_date, e.category, e.description, e.amount,
         e.created_by, u.username AS created_by_name, e.created_at, e.updated_at
    FROM operational_expenses e
    LEFT JOIN user_account u ON u.id = e.created_by
`;

export async function listExpenses(params: {
  month?: string;
  category?: string;
  limit: number;
  offset: number;
}): Promise<ExpenseRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];

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
}

/** Pengeluaran operasional (gaji, listrik, internet, dst). OWNER-only di route. */
export async function createExpense(input: ExpenseInput, createdBy: number | null): Promise<ExpenseRow> {
  return withTx(async (client) => {
    const res = await client.query<{ id: number }>(
      `INSERT INTO operational_expenses (expense_date, category, description, amount, created_by)
       VALUES (COALESCE($1::date, CURRENT_DATE), UPPER($2), $3, $4, $5) RETURNING id`,
      [input.expense_date ?? null, input.category.trim(), input.description ?? null, input.amount, createdBy],
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
    if (sets.length === 0) return getExpense(id, client);

    args.push(new Date());
    sets.push(`updated_at = $${args.length}`);
    args.push(id);
    await client.query(`UPDATE operational_expenses SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
    return getExpense(id, client);
  }, 'expense-update');
}
