import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round3, withTx } from '../utils/tx.js';
import { nextDocNo } from './docno.js';

export interface OpnameItemRow {
  id: number;
  opname_id: number;
  product_id: number;
  product_name: string | null;
  unit: string | null;
  batch_id: number | null;
  batch_code: string | null;
  system_qty: number;
  physical_qty: number;
  difference: number;
  note: string | null;
}

export interface OpnameRow {
  id: number;
  opname_no: string;
  opname_date: string;
  note: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  item_count?: number;
  total_difference?: number;
}

const SELECT_OPNAME = `
  SELECT o.id, o.opname_no, o.opname_date, o.note, o.created_by, u.username AS created_by_name, o.created_at,
         (SELECT count(*)::int FROM stock_opname_items i WHERE i.opname_id = o.id) AS item_count,
         (SELECT COALESCE(sum(i.difference), 0)::numeric(14,3) FROM stock_opname_items i WHERE i.opname_id = o.id) AS total_difference
    FROM stock_opnames o
    LEFT JOIN user_account u ON u.id = o.created_by
`;

const SELECT_ITEM = `
  SELECT i.id, i.opname_id, i.product_id, p.name AS product_name, p.unit, i.batch_id, b.batch_code,
         i.system_qty, i.physical_qty, i.difference, i.note
    FROM stock_opname_items i
    JOIN product p ON p.id = i.product_id
    LEFT JOIN stock_batches b ON b.id = i.batch_id
`;

export async function listOpnames(params: { date?: string; limit: number; offset: number }): Promise<OpnameRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];
  if (params.date) {
    args.push(params.date);
    where.push(`o.opname_date = $${args.length}::date`);
  }
  args.push(params.limit, params.offset);
  const res = await pool.query<OpnameRow>(
    `${SELECT_OPNAME} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY o.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}

export async function getOpname(id: number, client: PoolClient | null = null): Promise<OpnameRow & { items: OpnameItemRow[] }> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);
  const head = await runner(`${SELECT_OPNAME} WHERE o.id = $1`, [id]);
  if (!head.rows[0]) throw new ApiError('NOT_FOUND', `Opname id=${id} tidak ditemukan`);
  const items = await runner(`${SELECT_ITEM} WHERE i.opname_id = $1 ORDER BY i.id ASC`, [id]);
  return { ...head.rows[0], items: items.rows };
}

export interface OpnameInputItem {
  product_id: number;
  physical_qty: number;
  batch_id?: number | null;
  note?: string | null;
}

export interface OpnameInput {
  items: OpnameInputItem[];
  note?: string | null;
}

/**
 * FASE 6 - Stok opname harian, satu transaksi:
 *  1. system_qty dibaca dari agregat stock_batches (query langsung, tanpa view)
 *  2. simpan header + item (difference = generated column physical - system)
 *  3. untuk selisih != 0 insert movement ADJUSTMENT -> trigger menyinkronkan qty_remaining
 *
 * Batas DB: stock_batches punya CHECK qty_remaining <= qty_received, jadi selisih positif
 * hanya bisa dikoreksi bila masih berada di dalam kapasitas batch (dicek di sini agar
 * pesannya jelas, bukan error CHECK mentah).
 */
export async function createOpname(input: OpnameInput, userId: number): Promise<OpnameRow & { items: OpnameItemRow[] }> {
  const seen = new Set<number>();
  for (const it of input.items) {
    if (seen.has(it.product_id)) {
      throw new ApiError('VALIDATION_ERROR', `Produk id=${it.product_id} muncul lebih dari sekali pada opname yang sama`);
    }
    seen.add(it.product_id);
  }

  return withTx(async (client) => {
    const opnameNo = await nextDocNo(client, 'opname', env.businessTz);
    const head = await client.query<{ id: number }>(
      `INSERT INTO stock_opnames (opname_no, note, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [opnameNo, input.note ?? null, userId],
    );
    const opnameId = head.rows[0]!.id;

    for (const item of input.items) {
      const product = await client.query<{ id: number; name: string }>(`SELECT id, name FROM product WHERE id = $1`, [
        item.product_id,
      ]);
      if (!product.rows[0]) {
        throw new ApiError('VALIDATION_ERROR', `Produk id=${item.product_id} tidak ditemukan`);
      }

      // system_qty: agregat langsung dari stock_batches (opsional per batch).
      let systemRes: { system_qty: number; batch_id: number | null };
      if (item.batch_id) {
        const b = await client.query<{ qty_remaining: number }>(
          `SELECT qty_remaining FROM stock_batches WHERE id = $1 AND product_id = $2 FOR UPDATE`,
          [item.batch_id, item.product_id],
        );
        if (!b.rows[0]) {
          throw new ApiError('BATCH_NOT_FOUND', `Batch id=${item.batch_id} bukan batch dari produk id=${item.product_id}`);
        }
        systemRes = { system_qty: Number(b.rows[0].qty_remaining), batch_id: item.batch_id };
      } else {
        const s = await client.query<{ total: number }>(
          `SELECT COALESCE(sum(qty_remaining), 0)::numeric(14,3) AS total
             FROM stock_batches WHERE product_id = $1`,
          [item.product_id],
        );
        systemRes = { system_qty: Number(s.rows[0]?.total ?? 0), batch_id: null };
      }

      const diff = round3(item.physical_qty - systemRes.system_qty);
      await client.query(
        `INSERT INTO stock_opname_items (opname_id, product_id, batch_id, system_qty, physical_qty, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [opnameId, item.product_id, systemRes.batch_id, systemRes.system_qty, item.physical_qty, item.note ?? null],
      );

      if (diff !== 0) {
        const target = systemRes.batch_id ?? (await pickAdjustmentBatch(client, item.product_id));
        if (target === null) {
          throw new ApiError(
            'VALIDATION_ERROR',
            `Selisih opname produk "${product.rows[0].name}" tidak dapat dikoreksi: belum ada batch stok`,
          );
        }
        const cap = await client.query<{ qty_received: number; qty_remaining: number }>(
          `SELECT qty_received, qty_remaining FROM stock_batches WHERE id = $1 FOR UPDATE`,
          [target],
        );
        const row = cap.rows[0]!;
        if (diff > 0 && Number(row.qty_remaining) + diff > Number(row.qty_received)) {
          throw new ApiError(
            'VALIDATION_ERROR',
            `Selisih opname +${diff} melebihi kapasitas batch (sisa ${row.qty_remaining} / diterima ${row.qty_received}). ` +
              `Buat batch pembelian baru untuk mencatat kelebihan stok.`,
          );
        }

        await client.query(
          `INSERT INTO stock_movements
             (product_id, batch_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by)
           VALUES ($1, $2, 'ADJUSTMENT', $3, $4, 'OPNAME', $5, $6, $7)`,
          [
            item.product_id,
            target,
            diff,
            Number(row.qty_remaining) > 0 ? await currentUnitCost(client, target) : 0,
            opnameId,
            `Koreksi opname ${opnameNo}: system ${systemRes.system_qty} -> fisik ${item.physical_qty}`,
            userId,
          ],
        );
      }
    }

    return getOpname(opnameId, client);
  }, 'opname');
}

async function pickAdjustmentBatch(client: PoolClient, productId: number): Promise<number | null> {
  const res = await client.query<{ id: number }>(
    `SELECT id FROM stock_batches WHERE product_id = $1 ORDER BY expired_date ASC NULLS LAST, id ASC LIMIT 1`,
    [productId],
  );
  return res.rows[0]?.id ?? null;
}

async function currentUnitCost(client: PoolClient, batchId: number): Promise<number> {
  const res = await client.query<{ unit_cost: number }>(`SELECT unit_cost FROM stock_batches WHERE id = $1`, [batchId]);
  return Number(res.rows[0]?.unit_cost ?? 0);
}
