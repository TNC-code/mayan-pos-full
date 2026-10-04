import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round2, round3, withTx } from '../utils/tx.js';
import { nextDocNo } from './docno.js';

/** Penyebab selisih opname (lihat constraint chk_opname_item_cause). */
export type OpnameCause = 'RUSAK' | 'HILANG' | 'SALAH_HITUNG' | 'LAIN';

export interface OpnameItemRow {
  id: number;
  opname_id: number;
  product_id: number;
  product_name: string | null;
  unit: string | null;
  batch_id: number | null;
  batch_code: string | null;
  /** Selisih barang GOOD (generated column DB: physical_qty - system_qty). */
  system_qty: number;
  physical_qty: number;
  difference: number;
  /** Snapshot stok rusak sistem saat opname (kolom 0006). */
  system_qty_damaged: number;
  physical_qty_damaged: number;
  /** Selisih barang rusak (generated column DB). */
  damaged_difference: number;
  cause: OpnameCause | null;
  /** Harga beli acuan: unit_cost batch, fallback rata-rata tertimbang per produk. */
  unit_cost: number;
  /** Nilai rupiah selisih GOOD. */
  value_difference: number;
  /** Nilai rupiah selisih RUSAK. */
  value_difference_damaged: number;
  /** Nilai rupiah selisih total (GOOD + RUSAK); negatif = rugi. */
  value_difference_total: number;
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
  total_difference_damaged?: number;
  total_value_difference?: number;
  total_loss_value?: number;
  total_gain_value?: number;
}

const SELECT_OPNAME = `
  SELECT o.id, o.opname_no, o.opname_date, o.note, o.created_by, u.username AS created_by_name, o.created_at,
         (SELECT count(*)::int FROM stock_opname_items i WHERE i.opname_id = o.id) AS item_count,
         (SELECT COALESCE(sum(i.difference), 0)::numeric(14,3) FROM stock_opname_items i WHERE i.opname_id = o.id) AS total_difference,
         (SELECT COALESCE(sum(i.damaged_difference), 0)::numeric(14,3) FROM stock_opname_items i WHERE i.opname_id = o.id) AS total_difference_damaged,
         (SELECT COALESCE(sum((i.difference + i.damaged_difference) * COALESCE((SELECT b.unit_cost FROM stock_batches b WHERE b.id = i.batch_id), av.unit_cost, 0)), 0)::numeric(14,2)
            FROM stock_opname_items i
            LEFT JOIN (SELECT product_id, COALESCE(sum(unit_cost * qty_remaining) / NULLIF(sum(qty_remaining), 0), 0) AS unit_cost
                         FROM stock_batches GROUP BY product_id) av ON av.product_id = i.product_id
           WHERE i.opname_id = o.id) AS total_value_difference
    FROM stock_opnames o
    LEFT JOIN user_account u ON u.id = o.created_by
`;

/**
 * Harga beli acuan per item opname: unit_cost batch yang diopname; kalau opname per produk
 * (tanpa batch) pakai rata-rata tertimbang seluruh batch produk tsb. Dipakai untuk
 * mengubah selisih qty menjadi nilai rupiah.
 */
const UNIT_COST_EXPR = `
  COALESCE(
    (SELECT b.unit_cost FROM stock_batches b WHERE b.id = i.batch_id),
    (SELECT COALESCE(sum(b2.unit_cost * b2.qty_remaining) / NULLIF(sum(b2.qty_remaining), 0), 0)
       FROM stock_batches b2 WHERE b2.product_id = i.product_id),
    0
  )
`;

const SELECT_ITEM = `
  SELECT i.id, i.opname_id, i.product_id, p.name AS product_name, p.unit, i.batch_id, b.batch_code,
         i.system_qty, i.physical_qty, i.difference,
         i.system_qty_damaged, COALESCE(i.physical_qty_damaged, i.system_qty_damaged) AS physical_qty_damaged,
         i.damaged_difference, i.cause,
         (${UNIT_COST_EXPR})::numeric(14,2) AS unit_cost,
         (i.difference * (${UNIT_COST_EXPR}))::numeric(14,2) AS value_difference,
         (i.damaged_difference * (${UNIT_COST_EXPR}))::numeric(14,2) AS value_difference_damaged,
         ((i.difference + i.damaged_difference) * (${UNIT_COST_EXPR}))::numeric(14,2) AS value_difference_total,
         i.note
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
  return rowsWithTotals(res.rows);
}

export async function getOpname(
  id: number,
  client: PoolClient | null = null,
): Promise<OpnameRow & { items: OpnameItemRow[] }> {
  const runner = client ? client.query.bind(client) : pool.query.bind(pool);
  const head = await runner(`${SELECT_OPNAME} WHERE o.id = $1`, [id]);
  if (!head.rows[0]) throw new ApiError('NOT_FOUND', `Opname id=${id} tidak ditemukan`);
  const items = await runner(`${SELECT_ITEM} WHERE i.opname_id = $1 ORDER BY i.id ASC`, [id]);
  const [detail] = rowsWithTotals([head.rows[0] as OpnameRow]);
  return { ...detail, items: items.rows as OpnameItemRow[] };
}

/** Tambahkan total rugi/lebih (Rp) yang tidak bisa diringkas di SQL aggregate. */
function rowsWithTotals(rows: OpnameRow[]): OpnameRow[] {
  return rows.map((r) => {
    const total = Number(r.total_value_difference ?? 0);
    return {
      ...r,
      total_loss_value: total < 0 ? round2(Math.abs(total)) : 0,
      total_gain_value: total > 0 ? round2(total) : 0,
    };
  });
}

export interface OpnameInputItem {
  product_id: number;
  physical_qty: number;
  /** Physical count barang rusak; default = system damaged (tanpa adjustment). */
  physical_qty_damaged?: number | null;
  cause?: OpnameCause | null;
  batch_id?: number | null;
  note?: string | null;
}

export interface OpnameInput {
  items: OpnameInputItem[];
  note?: string | null;
}

/** Snapshot stok (GOOD + RUSAK) dari stock_batches untuk batch tertentu / agregat produk. */
interface SystemSnapshot {
  batch_id: number | null;
  system_qty: number;
  system_qty_damaged: number;
}

async function readSystemSnapshot(
  client: PoolClient,
  productId: number,
  batchId: number | null,
  lock: boolean,
): Promise<SystemSnapshot> {
  if (batchId) {
    const b = await client.query<{ qty_remaining: string; qty_damaged: string }>(
      `SELECT qty_remaining, qty_damaged FROM stock_batches WHERE id = $1 AND product_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [batchId, productId],
    );
    if (!b.rows[0]) {
      throw new ApiError('BATCH_NOT_FOUND', `Batch id=${batchId} bukan batch dari produk id=${productId}`);
    }
    return {
      batch_id: batchId,
      system_qty: Number(b.rows[0].qty_remaining),
      system_qty_damaged: Number(b.rows[0].qty_damaged),
    };
  }

  const s = await client.query<{ good: string; damaged: string }>(
    `SELECT COALESCE(sum(qty_remaining), 0)::numeric(14,3) AS good,
            COALESCE(sum(qty_damaged), 0)::numeric(14,3) AS damaged
       FROM stock_batches WHERE product_id = $1`,
    [productId],
  );
  return {
    batch_id: null,
    system_qty: Number(s.rows[0]?.good ?? 0),
    system_qty_damaged: Number(s.rows[0]?.damaged ?? 0),
  };
}

/**
 * FASE 6 (v2) - Stok opname harian, satu transaksi:
 *  1. system_qty (GOOD) + system_qty_damaged (RUSAK) dibaca dari agregat stock_batches
 *  2. simpan header + item (difference GOOD = generated column DB)
 *  3. selisih GOOD != 0  -> movement ADJUSTMENT condition GOOD  -> trigger ubah qty_remaining
 *     selisih RUSAK != 0 -> movement ADJUSTMENT condition RUSAK -> trigger ubah qty_damaged
 *  4. `physical_qty_damaged` tidak diisi = diasumsikan sama dengan sistem, jadi TIDAK ada
 *     adjustment barang rusak (beban hitung kasir tidak naik; lihat plan §7).
 *
 * Batas DB: stock_batches punya CHECK qty_remaining <= qty_received, jadi selisih positif
 * GOOD hanya bisa dikoreksi bila masih berada di dalam kapasitas batch (dicek di sini agar
 * pesannya jelas, bukan error CHECK mentah). qty_damaged tidak punya batas kapasitas.
 */
export async function createOpname(
  input: OpnameInput,
  userId: number,
): Promise<OpnameRow & { items: OpnameItemRow[] }> {
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

      // Snapshot sistem: GOOD (qty_remaining) + RUSAK (qty_damaged), opsional per batch.
      const sys = await readSystemSnapshot(client, item.product_id, item.batch_id ?? null, true);
      const physicalDamaged =
        item.physical_qty_damaged === undefined || item.physical_qty_damaged === null
          ? sys.system_qty_damaged
          : item.physical_qty_damaged;

      const diff = round3(item.physical_qty - sys.system_qty);
      const damagedDiff = round3(physicalDamaged - sys.system_qty_damaged);

      await client.query(
        `INSERT INTO stock_opname_items
           (opname_id, product_id, batch_id, system_qty, physical_qty, system_qty_damaged, physical_qty_damaged, cause, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          opnameId,
          item.product_id,
          sys.batch_id,
          sys.system_qty,
          item.physical_qty,
          sys.system_qty_damaged,
          physicalDamaged,
          item.cause ?? null,
          item.note ?? null,
        ],
      );

      if (diff !== 0) {
        const target = sys.batch_id ?? (await pickAdjustmentBatch(client, item.product_id, false));
        if (target === null) {
          throw new ApiError(
            'VALIDATION_ERROR',
            `Selisih opname produk "${product.rows[0].name}" tidak dapat dikoreksi: belum ada batch stok`,
          );
        }
        const cap = await client.query<{ qty_received: string; qty_remaining: string; unit_cost: string }>(
          `SELECT qty_received, qty_remaining, unit_cost FROM stock_batches WHERE id = $1 FOR UPDATE`,
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
             (product_id, batch_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by, condition)
           VALUES ($1, $2, 'ADJUSTMENT', $3, $4, 'OPNAME', $5, $6, $7, 'GOOD')`,
          [
            item.product_id,
            target,
            diff,
            Number(row.qty_remaining) > 0 ? Number(row.unit_cost) : 0,
            opnameId,
            `Koreksi opname ${opnameNo}: system ${sys.system_qty} -> fisik ${item.physical_qty}`,
            userId,
          ],
        );
      }

      if (damagedDiff !== 0) {
        // Barang rusak tidak ikut kapasitas batch; trigger yang menjaga qty_damaged >= 0.
        const target =
          sys.batch_id ??
          (await pickAdjustmentBatch(client, item.product_id, damagedDiff < 0));
        if (target === null) {
          throw new ApiError(
            'VALIDATION_ERROR',
            `Selisih opname barang rusak produk "${product.rows[0].name}" tidak dapat dikoreksi: belum ada batch stok`,
          );
        }
        const cap = await client.query<{ qty_damaged: string; unit_cost: string }>(
          `SELECT qty_damaged, unit_cost FROM stock_batches WHERE id = $1 FOR UPDATE`,
          [target],
        );
        const row = cap.rows[0]!;
        if (damagedDiff < 0 && Number(row.qty_damaged) + damagedDiff < 0) {
          throw new ApiError(
            'DAMAGED_QTY_INSUFFICIENT',
            `Selisih opname barang rusak ${damagedDiff} melebihi stok rusak yang tercatat pada batch #${target} (${row.qty_damaged})`,
          );
        }

        await client.query(
          `INSERT INTO stock_movements
             (product_id, batch_id, movement_type, qty_change, unit_cost, reference_type, reference_id, note, created_by, condition)
           VALUES ($1, $2, 'ADJUSTMENT', $3, $4, 'OPNAME', $5, $6, $7, 'RUSAK')`,
          [
            item.product_id,
            target,
            damagedDiff,
            Number(row.unit_cost),
            opnameId,
            `Koreksi opname ${opnameNo} (barang rusak): system ${sys.system_qty_damaged} -> fisik ${physicalDamaged}` +
              (item.cause ? ` [${item.cause}]` : ''),
            userId,
          ],
        );
      }
    }

    return getOpname(opnameId, client);
  }, 'opname');
}

/**
 * Batch tujuan koreksi. `forRemoval` (selisih negatif barang rusak) hanya memilih batch
 * yang benar-benar punya barang rusak, supaya tidak rely on pesan error trigger.
 */
async function pickAdjustmentBatch(
  client: PoolClient,
  productId: number,
  forRemoval: boolean,
): Promise<number | null> {
  const res = await client.query<{ id: number }>(
    `SELECT id FROM stock_batches
      WHERE product_id = $1 ${forRemoval ? 'AND qty_damaged > 0' : ''}
      ORDER BY expired_date ASC NULLS LAST, id ASC LIMIT 1`,
    [productId],
  );
  return res.rows[0]?.id ?? null;
}
