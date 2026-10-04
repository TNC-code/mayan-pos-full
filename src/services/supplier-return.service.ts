import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round2, round3 } from '../utils/tx.js';
import { nextDocNo } from './docno.js';
import { getWriteOffExpense, recordWriteOffExpense, type ExpenseRow } from './expense.service.js';
import { runIdempotent } from './idempotency.service.js';

/* ============================== types ============================== */

export type SupplierReturnStatus = 'PENDING' | 'REFUNDED' | 'WRITTEN_OFF';

export interface SupplierReturnRow {
  id: number;
  return_no: string;
  supplier_name: string;
  status: SupplierReturnStatus;
  total_cost: number;
  refunded_amount: number | null;
  refunded_method_id: number | null;
  refunded_method_code: string | null;
  refunded_method_name: string | null;
  refund_reference_no: string | null;
  refunded_at: string | null;
  settled_by: number | null;
  settled_by_name: string | null;
  note: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  /** true = retur dari skrip uji; dikecualikan dari `refund_distributor` P&L kecuali diminta. */
  is_test: boolean;
  item_count?: number;
  total_qty?: number;
}

export interface SupplierReturnItemRow {
  id: number;
  return_id: number;
  product_id: number;
  product_name: string | null;
  unit: string | null;
  batch_id: number | null;
  batch_code: string | null;
  qty: number;
  unit_cost: number;
  condition: string;
  subtotal: number;
}

export interface SupplierReturnDetail extends SupplierReturnRow {
  items: SupplierReturnItemRow[];
  /** Opex otomatis dari settle WRITTEN_OFF (null bila belum disettle / REFUNDED). */
  write_off_expense: ExpenseRow | null;
}

export interface SupplierReturnInputItem {
  batch_id: number;
  qty: number;
  /** Default = unit_cost batch (harga beli saat barang masuk). */
  unit_cost?: number | null;
}

export interface SupplierReturnInput {
  supplier_name: string;
  items: SupplierReturnInputItem[];
  note?: string | null;
  /**
   * Tanda data uji (T9, kolom `supplier_returns.is_test`). Default false = retur produksi.
   * Boleh diisi dari body agar e2e/agen skrip menandai sejak awal, tidak harus menunggu
   * `npm run mark-test-data`. Opex write-off turunannya mewarisi nilai ini.
   */
  is_test?: boolean | null;
}

export type SupplierReturnSettleInput =
  | {
      result: 'REFUNDED';
      amount: number;
      method_id?: number | null;
      reference_no?: string | null;
      note?: string | null;
    }
  | {
      result: 'WRITTEN_OFF';
      note?: string | null;
    };

/* ============================ selectors ============================ */

const SELECT_RETURN = `
  SELECT r.id, r.return_no, r.supplier_name, r.status, r.total_cost, r.refunded_amount,
         r.refunded_method_id, m.code AS refunded_method_code, m.name AS refunded_method_name,
         r.refund_reference_no, r.refunded_at, r.settled_by, su.username AS settled_by_name,
         r.note, r.created_by, cu.username AS created_by_name, r.created_at, r.is_test,
         (SELECT count(*)::int FROM supplier_return_items i WHERE i.return_id = r.id) AS item_count,
         (SELECT COALESCE(sum(i.qty), 0)::numeric(14,3) FROM supplier_return_items i WHERE i.return_id = r.id) AS total_qty
    FROM supplier_returns r
    LEFT JOIN payment_methods m ON m.id = r.refunded_method_id
    LEFT JOIN user_account su ON su.id = r.settled_by
    LEFT JOIN user_account cu ON cu.id = r.created_by
`;

const SELECT_RETURN_ITEM = `
  SELECT i.id, i.return_id, i.product_id, p.name AS product_name, p.unit, i.batch_id, b.batch_code,
         i.qty, i.unit_cost, i.condition,
         (i.qty * i.unit_cost)::numeric(14,2) AS subtotal
    FROM supplier_return_items i
    JOIN product p ON p.id = i.product_id
    LEFT JOIN stock_batches b ON b.id = i.batch_id
`;

/* ============================== getter ============================== */

export async function listSupplierReturns(params: {
  status?: string;
  supplier_name?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  limit: number;
  offset: number;
}): Promise<SupplierReturnRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];

  if (params.status) {
    args.push(params.status);
    where.push(`r.status = $${args.length}`);
  }
  if (params.supplier_name) {
    args.push(params.supplier_name);
    where.push(`r.supplier_name ILIKE $${args.length}`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`(r.return_no ILIKE $${args.length} OR r.supplier_name ILIKE $${args.length})`);
  }
  // Tanggal retur = tanggal dibuatnya dokumen retur (jam server DB).
  if (params.date_from) {
    args.push(env.businessTz);
    const tzIdx = args.length;
    args.push(params.date_from);
    where.push(`(r.created_at AT TIME ZONE $${tzIdx})::date >= $${args.length}::date`);
  }
  if (params.date_to) {
    args.push(env.businessTz);
    const tzIdx = args.length;
    args.push(params.date_to);
    where.push(`(r.created_at AT TIME ZONE $${tzIdx})::date <= $${args.length}::date`);
  }

  args.push(params.limit, params.offset);
  const res = await pool.query<SupplierReturnRow>(
    `${SELECT_RETURN} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}

async function fetchDetail(client: PoolClient | null, id: number): Promise<SupplierReturnDetail> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);

  const head = await runner(`${SELECT_RETURN} WHERE r.id = $1`, [id]);
  if (!head.rows[0]) {
    throw new ApiError('NOT_FOUND', `Retur distributor id=${id} tidak ditemukan`);
  }
  const items = await runner(`${SELECT_RETURN_ITEM} WHERE i.return_id = $1 ORDER BY i.id ASC`, [id]);
  const expense = await getWriteOffExpense(client, id);

  return { ...(head.rows[0] as SupplierReturnRow), items: items.rows as SupplierReturnItemRow[], write_off_expense: expense };
}

export async function getSupplierReturn(id: number): Promise<SupplierReturnDetail> {
  return fetchDetail(null, id);
}

/* ========================= helper validasi ========================= */

/**
 * Kunci baris batch (FOR UPDATE) lalu pastikan qty_damaged cukup.
 * BARANG RUSAK hanya boleh keluar lewat retur distributor, jadi penjaga utamanya
 * ada di trigger fn_stock_movement_apply ("Stok rusak batch ... tidak cukup");
 * pengecekan di sini supaya pesannya jelas sebelum DB yang menolak.
 */
async function assertDamagedAvailable(
  client: PoolClient,
  batchId: number,
  qty: number,
): Promise<{ product_id: number; batch_code: string; unit_cost: number; qty_damaged: number }> {
  const res = await client.query<{ product_id: number; batch_code: string; unit_cost: string; qty_damaged: string }>(
    `SELECT product_id, batch_code, unit_cost, qty_damaged
       FROM stock_batches
      WHERE id = $1
      FOR UPDATE`,
    [batchId],
  );
  const batch = res.rows[0];
  if (!batch) {
    throw new ApiError('BATCH_NOT_FOUND', `Batch id=${batchId} tidak ditemukan`);
  }

  const available = Number(batch.qty_damaged);
  if (round3(available - qty) < 0) {
    throw new ApiError(
      'DAMAGED_QTY_INSUFFICIENT',
      `Stok rusak batch ${batch.batch_code} tidak cukup: tersedia ${available}, diminta ${qty}`,
    );
  }
  return {
    product_id: batch.product_id,
    batch_code: batch.batch_code,
    unit_cost: Number(batch.unit_cost),
    qty_damaged: available,
  };
}

/** Metode pembayaran harus ada & aktif (distributor membayar balik lewat kanal ini). */
async function assertMethodUsable(client: PoolClient, methodId: number): Promise<void> {
  const res = await client.query<{ is_active: boolean }>(`SELECT is_active FROM payment_methods WHERE id = $1`, [
    methodId,
  ]);
  const m = res.rows[0];
  if (!m) throw new ApiError('PAYMENT_METHOD_NOT_FOUND', `Metode pembayaran id=${methodId} tidak ditemukan`);
  if (!m.is_active) throw new ApiError('PAYMENT_METHOD_INACTIVE', 'Metode pembayaran tidak aktif');
}

/* ===================== POST /supplier-returns (UC-B) ===================== */

/**
 * Retur barang rusak ke distributor (UC-B), SATU transaksi DB:
 *   1. kunci batch tiap item (FOR UPDATE) + validasi qty <= qty_damaged
 *   2. insert header `supplier_returns` (status PENDING, total_cost = Σ qty × unit_cost)
 *   3. insert `supplier_return_items`
 *   4. insert `stock_movements OUT` condition RUSAK, reference SUPPLIER_RETURN
 *      -> trigger fn_stock_movement_apply yang mengurang qty_damaged (aplikasi TIDAK
 *         menghitung stok sendiri).
 * Dilingkupi Idempotency-Key agar retry tidak membuat retur ganda.
 */
export async function createSupplierReturn(
  input: SupplierReturnInput,
  userId: number,
  idempotencyKey: string,
): Promise<{ supplierReturn: SupplierReturnDetail; replayed: boolean }> {
  const seen = new Set<number>();
  for (const item of input.items) {
    if (seen.has(item.batch_id)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `batch_id=${item.batch_id} muncul lebih dari sekali pada retur yang sama`,
      );
    }
    seen.add(item.batch_id);
  }

  const result = await runIdempotent<SupplierReturnDetail>(
    'POST /supplier-returns',
    idempotencyKey,
    async (client) => {
      // Kunci semua batch lebih dulu (urut id) supaya dua kasir retur batch yang sama
      // tidak saling menimpa angka qty_damaged (deadlock dihindari dengan urutan tetap).
      const ordered = [...input.items].sort((a, b) => a.batch_id - b.batch_id);

      const lines: Array<{
        batch_id: number;
        product_id: number;
        batch_code: string;
        qty: number;
        unit_cost: number;
        subtotal: number;
      }> = [];

      for (const item of ordered) {
        if (!Number.isFinite(item.qty) || item.qty <= 0) {
          throw new ApiError('VALIDATION_ERROR', `qty retur untuk batch id=${item.batch_id} harus lebih besar dari 0`);
        }
        const batch = await assertDamagedAvailable(client, item.batch_id, item.qty);
        const unitCost = item.unit_cost ?? batch.unit_cost;
        if (!Number.isFinite(unitCost) || unitCost < 0) {
          throw new ApiError('VALIDATION_ERROR', `unit_cost untuk batch id=${item.batch_id} tidak boleh negatif`);
        }
        lines.push({
          batch_id: item.batch_id,
          product_id: batch.product_id,
          batch_code: batch.batch_code,
          qty: round3(item.qty),
          unit_cost: round2(unitCost),
          subtotal: round2(round3(item.qty) * round2(unitCost)),
        });
      }

      const totalCost = round2(lines.reduce((sum, l) => sum + l.subtotal, 0));

      const returnNo = await nextDocNo(client, 'supplierReturn', env.businessTz);
      const head = await client.query<{ id: number }>(
        `INSERT INTO supplier_returns (return_no, supplier_name, status, total_cost, note, created_by, is_test)
         VALUES ($1, $2, 'PENDING', $3, $4, $5, COALESCE($6, false))
         RETURNING id`,
        [returnNo, input.supplier_name.trim(), totalCost, input.note ?? null, userId, input.is_test ?? null],
      );
      const returnId = head.rows[0]!.id;

      for (const line of lines) {
        await client.query(
          `INSERT INTO supplier_return_items (return_id, product_id, batch_id, qty, unit_cost, condition)
           VALUES ($1, $2, $3, $4, $5, 'RUSAK')`,
          [returnId, line.product_id, line.batch_id, line.qty, line.unit_cost],
        );

        // OUT barang rusak -> trigger mengurangi qty_damaged batch tersebut.
        await client.query(
          `INSERT INTO stock_movements
             (product_id, batch_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by, condition)
           VALUES ($1, $2, 'OUT', $3, $4, 'SUPPLIER_RETURN', $5, $6, $7, 'RUSAK')`,
          [
            line.product_id,
            line.batch_id,
            -line.qty,
            line.unit_cost,
            returnId,
            `Retur distributor ${returnNo}: ${line.qty} rusak dari batch ${line.batch_code} ke ${input.supplier_name.trim()}`,
            userId,
          ],
        );
      }

      return { status: 201, body: await fetchDetail(client, returnId) };
    },
  );

  return { supplierReturn: result.body, replayed: result.replayed };
}

/* ================ POST /supplier-returns/{id}/settle (UC-B) ================ */

/**
 * Penyelesaian retur distributor, dua kemungkinan (discriminated union di zod):
 *  - REFUNDED   : distributor mengembalikan uang -> isi refunded_* + status REFUNDED
 *  - WRITTEN_OFF: distributor menolak -> status WRITTEN_OFF + OTOMATIS jadi opex
 *                  BARANG_RUSAK (source SUPPLIER_RETURN, ter-link supplier_return_id)
 *                  di transaksi yang SAMA.
 * Guard: status harus PENDING, selain itu 409 SUPPLIER_RETURN_SETTLED.
 */
export async function settleSupplierReturn(
  id: number,
  input: SupplierReturnSettleInput,
  userId: number,
  idempotencyKey: string,
): Promise<{ supplierReturn: SupplierReturnDetail; replayed: boolean }> {
  // Scope memuat id konkret: key yang sama untuk 2 retur berbeda tidak boleh
  // me-replay response retur sebelumnya.
  const result = await runIdempotent<SupplierReturnDetail>(
    `POST /supplier-returns/${id}/settle`,
    idempotencyKey,
    async (client) => {
      const cur = await client.query<{ status: string; total_cost: string; return_no: string; supplier_name: string; is_test: boolean }>(
        `SELECT status, total_cost, return_no, supplier_name, is_test
           FROM supplier_returns WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = cur.rows[0];
      if (!row) {
        throw new ApiError('NOT_FOUND', `Retur distributor id=${id} tidak ditemukan`);
      }
      if (row.status !== 'PENDING') {
        throw new ApiError(
          'SUPPLIER_RETURN_SETTLED',
          `Retur distributor ${row.return_no} sudah berstatus ${row.status}, tidak bisa disettle lagi`,
        );
      }

      const totalCost = round2(Number(row.total_cost));

      if (input.result === 'REFUNDED') {
        if (!Number.isFinite(input.amount) || input.amount <= 0) {
          throw new ApiError('VALIDATION_ERROR', 'amount refund distributor harus lebih besar dari 0');
        }
        if (round2(input.amount) > totalCost) {
          throw new ApiError(
            'REFUND_AMOUNT_EXCEEDED',
            `Refund distributor ${round2(input.amount)} melebihi total biaya retur ${row.return_no} (${totalCost})`,
          );
        }
        if (input.method_id !== undefined && input.method_id !== null) {
          await assertMethodUsable(client, input.method_id);
        }

        await client.query(
          `UPDATE supplier_returns
              SET status = 'REFUNDED', refunded_amount = $2, refunded_method_id = $3,
                  refund_reference_no = $4, refunded_at = now(), settled_by = $5,
                  note = COALESCE($6, note)
            WHERE id = $1`,
          [
            id,
            round2(input.amount),
            input.method_id ?? null,
            input.reference_no ?? null,
            userId,
            input.note ?? null,
          ],
        );
      } else {
        await client.query(
          `UPDATE supplier_returns SET status = 'WRITTEN_OFF', settled_by = $2, note = COALESCE($3, note) WHERE id = $1`,
          [id, userId, input.note ?? null],
        );

        // Opex otomatis DALAM transaksi yang sama: retur + opex atomik.
        // is_test opex mewarisi tanda retur, supaya write-off retur uji tidak masuk P&L produksi.
        await recordWriteOffExpense(client, {
          supplier_return_id: id,
          return_no: row.return_no,
          supplier_name: row.supplier_name,
          amount: totalCost,
          created_by: userId,
          note: input.note ?? null,
          is_test: row.is_test,
        });
      }

      return { status: 200, body: await fetchDetail(client, id) };
    },
  );

  return { supplierReturn: result.body, replayed: result.replayed };
}
