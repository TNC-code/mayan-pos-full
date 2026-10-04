import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { ApiError } from '../utils/errors.js';
import { round2 } from '../utils/tx.js';
import { withTx } from '../utils/tx.js';

export interface CashSessionRow {
  id: number;
  user_id: number;
  username: string | null;
  opening_cash: number;
  opened_at: string;
  closed_at: string | null;
  closing_cash: number | null;
  expected_cash: number | null;
  difference: number | null;
  status: string;
  note: string | null;
}

const SELECT_SESSION = `
  SELECT cs.id, cs.user_id, u.username, cs.opening_cash, cs.opened_at, cs.closed_at,
         cs.closing_cash, cs.expected_cash, cs.difference, cs.status, cs.note
    FROM cash_sessions cs
    LEFT JOIN user_account u ON u.id = cs.user_id
`;

export async function listSessions(params: { user_id?: number; status?: string; limit: number; offset: number }): Promise<CashSessionRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];
  if (params.user_id !== undefined) {
    args.push(params.user_id);
    where.push(`cs.user_id = $${args.length}`);
  }
  if (params.status) {
    args.push(params.status);
    where.push(`cs.status = $${args.length}`);
  }
  args.push(params.limit, params.offset);
  const res = await pool.query<CashSessionRow>(
    `${SELECT_SESSION} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY cs.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}

export async function getSession(id: number, client: PoolClient | null = null): Promise<CashSessionRow> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);
  const res = await runner<CashSessionRow>(`${SELECT_SESSION} WHERE cs.id = $1`, [id]);
  if (!res.rows[0]) throw new ApiError('NOT_FOUND', `Sesi kasir id=${id} tidak ditemukan`);
  return res.rows[0];
}

/** Buka shift: satu user hanya boleh punya SATU sesi OPEN. */
export async function openSession(userId: number, openingCash: number, note?: string | null): Promise<CashSessionRow> {
  return withTx(async (client) => {
    const active = await client.query<{ id: number }>(
      `SELECT id FROM cash_sessions WHERE user_id = $1 AND status = 'OPEN' FOR UPDATE`,
      [userId],
    );
    if (active.rows[0]) {
      throw new ApiError('VALIDATION_ERROR', `Masih ada sesi OPEN (id=${active.rows[0].id}); tutup dulu sebelum buka shift baru`);
    }

    const ins = await client.query<{ id: number }>(
      `INSERT INTO cash_sessions (user_id, opening_cash, note) VALUES ($1, $2, $3) RETURNING id`,
      [userId, openingCash, note ?? null],
    );
    return getSession(ins.rows[0]!.id, client);
  }, 'cash-open');
}

/**
 * Tutup shift:
 * expected = saldo awal + pembayaran CASH oleh kasir ini selama shift - refund CASH oleh kasir ini.
 * difference = closing_cash - expected (selisih kas fisik vs sistem).
 */
export async function closeSession(
  id: number,
  userId: number,
  closingCash: number,
  note?: string | null,
): Promise<CashSessionRow> {
  return withTx(async (client) => {
    const cur = await client.query<{ id: number; user_id: number; opening_cash: number; opened_at: string; status: string }>(
      `SELECT id, user_id, opening_cash, opened_at, status FROM cash_sessions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const s = cur.rows[0];
    if (!s) throw new ApiError('NOT_FOUND', `Sesi kasir id=${id} tidak ditemukan`);
    if (s.status !== 'OPEN') throw new ApiError('VALIDATION_ERROR', `Sesi id=${id} sudah CLOSED`);
    // Kasir hanya boleh menutup sesinya sendiri; owner bebas (di route bisa dibatasi).
    if (s.user_id !== userId) {
      throw new ApiError('FORBIDDEN', 'Sesi ini milik user lain');
    }

    const cashIn = await client.query<{ total: number }>(
      `SELECT COALESCE(sum(p.amount), 0)::numeric(14,2) AS total
         FROM payments p
         JOIN payment_methods m ON m.id = p.method_id
        WHERE m.code = 'CASH' AND p.received_by = $1 AND p.paid_at >= $2 AND p.paid_at <= now()`,
      [s.user_id, s.opened_at],
    );
    const cashOut = await client.query<{ total: number }>(
      `SELECT COALESCE(sum(r.amount), 0)::numeric(14,2) AS total
         FROM refunds r
         JOIN payment_methods m ON m.id = r.method_id
        WHERE m.code = 'CASH' AND r.refunded_by = $1 AND r.refunded_at >= $2 AND r.refunded_at <= now()`,
      [s.user_id, s.opened_at],
    );

    const expected = round2(Number(s.opening_cash) + Number(cashIn.rows[0]?.total ?? 0) - Number(cashOut.rows[0]?.total ?? 0));
    const difference = round2(closingCash - expected);

    await client.query(
      `UPDATE cash_sessions
          SET closed_at = now(), closing_cash = $1, expected_cash = $2, difference = $3,
              status = 'CLOSED', note = COALESCE($4, note)
        WHERE id = $5`,
      [closingCash, expected, difference, note ?? null, id],
    );
    return getSession(id, client);
  }, 'cash-close');
}
