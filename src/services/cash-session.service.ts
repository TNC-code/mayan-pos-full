import { Op, type Includeable, type Transaction } from 'sequelize';
import { ApiError } from '../utils/errors.js';
import { round2, withOrmTx } from '../utils/tx.js';
import { mapOrmError } from '../utils/orm-errors.js';
import { CashSession, Payment, PaymentMethod, Refund, UserAccount } from '../models/index.js';

/**
 * Shift kasir di atas Sequelize (MP-5).
 *
 * Paritas penuh dengan versi raw SQL lama (`git show e33b3b5:src/services/cash-session.service.ts`):
 * bentuk response `CashSessionRow`, urutan list (`id DESC`), dan — yang paling
 * penting — RUMUS HITUNGAN KAS saat tutup shift:
 *
 *   expected_cash = opening_cash
 *                 + Σ payments  CASH oleh kasir ini  dengan paid_at     >= opened_at
 *                 − Σ refunds    CASH oleh kasir ini  dengan refunded_at >= opened_at
 *   difference   = closing_cash − expected_cash
 *
 * Batas atas `paid_at/refunded_at <= now()` ikut dipertahankan (menghilangkan
 * baris bertanggal "masa depan" bila ada koreksi manual jam).
 *
 * Yang tetap milik DB: CHECK `chk_cash_session_status` (OPEN/CLOSED) dan
 * `chk_opening_cash_nonneg`. Guard "satu user satu sesi OPEN" tetap di aplikasi
 * (kasir kedua yang membuka shift dalam milidetik yang sama harus dapat pesan
 * jelas, bukan menunggu constraint yang memang tidak ada).
 *
 * Catatan include: `PaymentMethod` punya default scope `is_active = true`,
 * sedangkan JOIN lama tidak memfilternya -> riwayat bayar/refund metode CASH
 * yang lalu dinonaktifkan tetap harus ikut dihitung (parity dengan
 * `sale.service.ts`).
 */

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

/** Kolom + join `username`, sama persis dengan SELECT versi lama. */
const WITH_USER: Includeable = {
  model: UserAccount,
  as: 'user',
  attributes: ['id', 'username'],
  required: false,
};

const SESSION_INCLUDES: Includeable[] = [WITH_USER];

type CashSessionWithUser = CashSession & { user?: { id: number; username: string } | null };

/** `timestamptz` -> string ISO (JSON `Date` otomatis sama seperti jalur raw SQL lama). */
function iso(value: Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toSessionRow(row: CashSessionWithUser): CashSessionRow {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.user?.username ?? null,
    opening_cash: row.opening_cash,
    opened_at: new Date(row.opened_at).toISOString(),
    closed_at: iso(row.closed_at),
    closing_cash: row.closing_cash,
    expected_cash: row.expected_cash,
    difference: row.difference,
    status: row.status,
    note: row.note,
  };
}

/* ============================== daftar shift ============================== */

export interface SessionListQuery {
  user_id?: number;
  status?: string;
  limit: number;
  offset: number;
}

/**
 * `GET /cash-sessions` — riwayat shift (default `id DESC`).
 * Filter `user_id`/`status` mengikuti kontrak yang sudah ada
 * (`cashListSchema` di controllers/schemas.ts dan openapi `GET /cash-sessions`).
 */
export async function listSessions(params: SessionListQuery): Promise<CashSessionRow[]> {
  const conditions: Record<string, unknown>[] = [];
  if (params.user_id !== undefined) conditions.push({ user_id: params.user_id });
  if (params.status) conditions.push({ status: params.status });

  const rows = await CashSession.findAll({
    where: { [Op.and]: conditions },
    include: SESSION_INCLUDES,
    // Include 1:1 (belongsTo) -> jumlah baris tidak berubah, LIMIT/OFFSET aman.
    subQuery: false,
    order: [['id', 'DESC']],
    limit: params.limit,
    offset: params.offset,
  });

  return (rows as unknown as CashSessionWithUser[]).map(toSessionRow);
}

/** `GET /cash-sessions/:id` — boleh dipanggil dalam transaksi (open/close). */
export async function getSession(id: number, transaction?: Transaction): Promise<CashSessionRow> {
  const row = await CashSession.findByPk(id, { include: SESSION_INCLUDES, transaction });
  if (!row) throw new ApiError('NOT_FOUND', `Sesi kasir id=${id} tidak ditemukan`);
  return toSessionRow(row as unknown as CashSessionWithUser);
}

/* ============================== buka shift ============================== */

/** `POST /cash-sessions/open` — satu user hanya boleh punya SATU sesi OPEN. */
export async function openSession(
  userId: number,
  openingCash: number,
  note?: string | null,
): Promise<CashSessionRow> {
  try {
    return await withOrmTx(async (transaction) => {
      if (openingCash < 0) {
        throw new ApiError('VALIDATION_ERROR', 'opening_cash tidak boleh negatif');
      }

      // Kunci baris sesi OPEN milik user ini (padanan `SELECT … FOR UPDATE`
      // versi lama) supaya dua request bersamaan tidak bisa sama-sama lolos.
      const active = await CashSession.findOne({
        where: { user_id: userId, status: 'OPEN' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (active) {
        throw new ApiError(
          'CONCURRENT_CONFLICT',
          `Masih ada sesi OPEN (id=${active.id}); tutup dulu sebelum buka shift baru`,
        );
      }

      const created = await CashSession.create(
        { user_id: userId, opening_cash: openingCash, note: note ?? null },
        { transaction },
      );
      return getSession(created.id, transaction);
    }, 'cash-open');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/* ============================== tutup shift ============================== */

/**
 * `POST /cash-sessions/:id/close`.
 *
 * `expected_cash` = opening + CASH masuk − refund CASH (kasir ini, sejak shift
 * dibuka); `difference` = closing − expected. `note` opsional: bila tidak
 * diisi, note saat buka shift TIDAK ditimpa (padanan `note = COALESCE($4, note)`).
 */
export async function closeSession(
  id: number,
  userId: number,
  closingCash: number,
  note?: string | null,
): Promise<CashSessionRow> {
  try {
    return await withOrmTx(async (transaction) => {
      const session = await CashSession.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!session) throw new ApiError('NOT_FOUND', `Sesi kasir id=${id} tidak ditemukan`);
      if (session.status !== 'OPEN') {
        throw new ApiError('CONCURRENT_CONFLICT', `Sesi id=${id} sudah CLOSED`);
      }
      // Kasir hanya boleh menutup sesinya sendiri; owner bebas (route `/close`
      // memang KASIR-only). Parity dengan versi lama.
      if (session.user_id !== userId) {
        throw new ApiError('FORBIDDEN', 'Sesi ini milik user lain');
      }

      const now = new Date();
      const cashIn = await sumCashPayments(transaction, session.user_id, session.opened_at, now);
      const cashOut = await sumCashRefunds(transaction, session.user_id, session.opened_at, now);

      const expected = round2(Number(session.opening_cash) + cashIn - cashOut);
      const difference = round2(closingCash - expected);

      // `note: undefined` = kolom tidak ikut di-update (COALESCE versi lama).
      await session.update(
        {
          closed_at: now,
          closing_cash: closingCash,
          expected_cash: expected,
          difference,
          status: 'CLOSED',
          ...(note === undefined || note === null ? {} : { note }),
        },
        { transaction },
      );

      return getSession(id, transaction);
    }, 'cash-close');
  } catch (err) {
    throw mapOrmError(err);
  }
}

/** Σ payments CASH kasir dalam rentang waktu shift. */
async function sumCashPayments(
  transaction: Transaction,
  userId: number,
  from: Date,
  to: Date,
): Promise<number> {
  const rows = await Payment.findAll({
    where: { received_by: userId, paid_at: { [Op.gte]: from, [Op.lte]: to } },
    attributes: ['amount'],
    include: [
      {
        model: PaymentMethod.scope('withInactive'),
        as: 'method',
        attributes: [],
        required: true,
        where: { code: 'CASH' },
      },
    ],
    subQuery: false,
    transaction,
  });
  return rows.reduce((sum, p) => sum + Number(p.amount), 0);
}

/** Σ refunds CASH kasir dalam rentang waktu shift (uang keluar). */
async function sumCashRefunds(
  transaction: Transaction,
  userId: number,
  from: Date,
  to: Date,
): Promise<number> {
  const rows = await Refund.findAll({
    where: { refunded_by: userId, refunded_at: { [Op.gte]: from, [Op.lte]: to } },
    attributes: ['amount'],
    include: [
      {
        model: PaymentMethod.scope('withInactive'),
        as: 'method',
        attributes: [],
        required: true,
        where: { code: 'CASH' },
      },
    ],
    subQuery: false,
    transaction,
  });
  return rows.reduce((sum, r) => sum + Number(r.amount), 0);
}