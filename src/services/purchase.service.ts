import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { withTx } from '../utils/tx.js';
import { nextDocNo } from './docno.js';

export interface BatchRow {
  id: number;
  batch_code: string;
  product_id: number;
  product_name: string | null;
  qty_received: number;
  qty_remaining: number;
  unit_cost: number;
  /** Mode markup harga jual usulan: AMOUNT (Rp/pcs) | PERCENT (%) | NULL (batch lama). */
  markup_type: 'AMOUNT' | 'PERCENT' | null;
  markup_value: number;
  /** Generated column DB: harga jual usulan batch ini (req #4: harga beli + markup). */
  suggested_price: number;
  expired_date: string | null;
  supplier: string | null;
  note: string | null;
  received_at: string;
  created_by: number | null;
  created_by_name: string | null;
}

const SELECT_BATCH = `
  SELECT b.id, b.batch_code, b.product_id, p.name AS product_name, p.unit,
         b.qty_received, b.qty_remaining, b.unit_cost,
         b.markup_type, b.markup_value, b.suggested_price,
         b.expired_date, b.supplier, b.note,
         b.received_at, b.created_by, u.username AS created_by_name
    FROM stock_batches b
    JOIN product p ON p.id = b.product_id
    LEFT JOIN user_account u ON u.id = b.created_by
`;

export async function listBatches(params: {
  product_id?: number;
  q?: string;
  active_only?: boolean;
  limit: number;
  offset: number;
}): Promise<BatchRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];

  if (params.product_id !== undefined) {
    args.push(params.product_id);
    where.push(`b.product_id = $${args.length}`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`(p.name ILIKE $${args.length} OR b.batch_code ILIKE $${args.length} OR p.barcode ILIKE $${args.length})`);
  }
  if (params.active_only) {
    where.push('b.qty_remaining > 0');
  }

  args.push(params.limit, params.offset);
  const res = await pool.query<BatchRow>(
    `${SELECT_BATCH} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY b.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}

export async function getBatch(id: number, client: PoolClient | null = null): Promise<BatchRow> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);
  const res = await runner(`SELECT * FROM (${SELECT_BATCH}) x WHERE x.id = $1`, [id]);
  if (!res.rows[0]) throw new ApiError('BATCH_NOT_FOUND', `Batch id=${id} tidak ditemukan`);
  return res.rows[0] as BatchRow;
}

export interface PurchaseInput {
  product_id: number;
  qty: number;
  unit_cost: number;
  markup_type: 'AMOUNT' | 'PERCENT';
  markup_value: number;
  expired_date?: string | null;
  supplier?: string | null;
  notes?: string | null;
}

/**
 * FASE 2 - Barang masuk: 1 batch + 1 movement IN dalam SATU transaksi.
 * `qty_remaining` tidak dihitung aplikasi; trigger trg_stock_movement_apply yang
 * menambahkannya dari qty_change movement.
 * Side effect DB: trg_batch_update_product_cost menyelaraskan product.harga_beli
 * dengan unit_cost batch terbaru, dan (sejak 0010) product.harga_jual dengan
 * suggested_price batch (markup AMOUNT/PERCENT — baruplan.md req #3-4).
 */
export async function createPurchase(input: PurchaseInput, createdBy: number | null): Promise<BatchRow> {
  return withTx(async (client) => {
    const product = await client.query<{ id: number; name: string; is_active: boolean }>(
      `SELECT id, name, is_active FROM product WHERE id = $1 FOR SHARE`,
      [input.product_id],
    );
    if (!product.rows[0]) {
      throw new ApiError('VALIDATION_ERROR', `Produk id=${input.product_id} tidak ditemukan`);
    }

    const batchCode = await nextDocNo(client, 'batch', env.businessTz);

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO stock_batches
         (batch_code, product_id, qty_received, qty_remaining, unit_cost,
          markup_type, markup_value, expired_date, supplier, note, created_by)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        batchCode,
        input.product_id,
        input.qty,
        input.unit_cost,
        input.markup_type,
        input.markup_value,
        input.expired_date ?? null,
        input.supplier ?? null,
        input.notes ?? null,
        createdBy,
      ],
    );
    const batchId = inserted.rows[0]!.id;

    // Movement IN: trigger trg_stock_movement_apply yang menaikkan qty_remaining
    // (aplikasi tidak boleh menghitung stok sendiri).
    await client.query(
      `INSERT INTO stock_movements
         (product_id, batch_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by)
       VALUES ($1, $2, 'IN', $3, $4, 'PURCHASE', $2, $5, $6)`,
      [
        input.product_id,
        batchId,
        input.qty,
        input.unit_cost,
        `Barang masuk: ${input.qty} @ ${input.unit_cost}${input.expired_date ? ` (exp ${input.expired_date})` : ''}`,
        createdBy,
      ],
    );

    return getBatch(batchId, client);
  }, 'purchase');
}

/* ================= picker batch layar kasir (baruplan.md req #1) ================= */

/**
 * Daftar batch SATU produk untuk modal "Detail Item" di POS: kasir melihat tiap
 * batch punya sisa stok (qty_remaining), harga beli (unit_cost — floor nego), dan
 * harga jual usulan (suggested_price dari markup batch). Urutan FIFO dengan
 * expired NULLS LAST (sama dengan auto-FIFO resolveBatchId di sale.service).
 */
export async function listProductBatches(
  productId: number,
  availableOnly: boolean,
): Promise<BatchRow[]> {
  const product = await pool.query<{ id: number }>(`SELECT id FROM product WHERE id = $1`, [productId]);
  if (!product.rows[0]) {
    throw new ApiError('NOT_FOUND', `Produk id=${productId} tidak ditemukan`);
  }

  const args: unknown[] = [productId];
  const where = ['b.product_id = $1'];
  if (availableOnly) where.push('b.qty_remaining > 0');
  args.push(200);

  const res = await pool.query<BatchRow>(
    `${SELECT_BATCH} WHERE ${where.join(' AND ')}
     ORDER BY b.expired_date ASC NULLS LAST, b.id ASC
     LIMIT $2`,
    args as never[],
  );
  return res.rows;
}
