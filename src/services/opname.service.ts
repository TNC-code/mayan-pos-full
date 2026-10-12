import { Op, QueryTypes, type Transaction } from 'sequelize';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { round2, round3, withOrmTx } from '../utils/tx.js';
import { mapOrmError } from '../utils/orm-errors.js';
import { isoDateOnly } from '../utils/dates.js';
import {
  Product,
  StockBatch,
  StockMovement,
  StockOpname,
  StockOpnameItem,
  sequelize,
  type OpnameCause,
} from '../models/index.js';
import { nextDocNo } from './docno.js';

/**
 * Opname stok di atas Sequelize (MP-5).
 *
 * Dua jalur yang disengaja (hybrid §D4, sama seperti `stock.service.ts`):
 *  - TULIS (`createOpname`) murni model + `withOrmTx`:
 *      header -> item per baris (snapshot sistem) -> movement ADJUSTMENT GOOD/RUSAK;
 *    semua koreksi stok diteruskan ke trigger `trg_stock_movement_apply`, service
 *    tidak pernah menulis `qty_remaining`/`qty_damaged` langsung.
 *  - BACA daftar/detail lewat `sequelize.query` dengan SQL yang disalin PERSIS
 *    dari versi lama, karena agregatnya berantai lintas-tabel
 *    (`total_value_difference` = Σ (difference + damaged_difference) × harga beli
 *    acuan, di mana harga acuan = `unit_cost` batch atau rata-rata tertimbang
 *    batch produk) — jauh lebih ringkas & teruji daripada builder ORM, dan
 *    bentuk response FE harus tidak bergeser. Nilai filter tetap di-bind.
 *
 * Kolom `difference` & `damaged_difference` adalah GENERATED column DB -> hanya
 * dibaca, tidak pernah ditulis (lihat stock-opname-item.model.ts).
 *
 * Kunci baris `FOR UPDATE` dipakai persis seperti versi lama: baris batch
 * tujuan dikunci sebelum snapshot/koreksi, sehingga dua opname paralel untuk
 * produk yang sama tidak bisa menghitung selisih dari snapshot yang sama.
 */

export type { OpnameCause };

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

export interface OpnameDetail extends OpnameRow {
  items: OpnameItemRow[];
}

/* ============================== SQL baca (hybrid) ============================== */

/** Baris mentah dari query agregat (kolom tanggal masih bentuk DB). */
type RawOpnameRow = Omit<OpnameRow, 'opname_date' | 'created_at'> & {
  opname_date: string | Date;
  created_at: string | Date;
};

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

/** `timestamptz` -> ISO; kolom `date` -> ISO lewat helper yang sama bentuk wire-nya. */
function isoTs(value: string | Date): string {
  return new Date(value).toISOString();
}

/** Normalisasi baris agregat + total rugi/lebih (parity `rowsWithTotals` versi lama). */
function toOpnameRow(row: RawOpnameRow): OpnameRow {
  const total = Number(row.total_value_difference ?? 0);
  return {
    id: row.id,
    opname_no: row.opname_no,
    opname_date: isoDateOnly(row.opname_date) as string,
    note: row.note,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: isoTs(row.created_at),
    item_count: row.item_count,
    total_difference: row.total_difference,
    total_difference_damaged: row.total_difference_damaged,
    total_value_difference: row.total_value_difference,
    total_loss_value: total < 0 ? round2(Math.abs(total)) : 0,
    total_gain_value: total > 0 ? round2(total) : 0,
  };
}

/* ============================== daftar opname ============================== */

export interface OpnameListQuery {
  date?: string;
  limit: number;
  offset: number;
}

/** `GET /opnames` — riwayat opname (default `id DESC`) + agregat selisih per opname. */
export async function listOpnames(params: OpnameListQuery): Promise<OpnameRow[]> {
  const binds: unknown[] = [];
  const where: string[] = [];
  const push = (value: unknown): string => {
    binds.push(value);
    return `$${binds.length}`;
  };

  if (params.date) where.push(`o.opname_date = ${push(params.date)}::date`);

  const limitIdx = binds.push(params.limit);
  const offsetIdx = binds.push(params.offset);

  const rows = (await sequelize.query(
    `${SELECT_OPNAME} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY o.id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    { bind: binds, type: QueryTypes.SELECT },
  )) as RawOpnameRow[];

  return rows.map(toOpnameRow);
}

/* ============================== detail opname ============================== */

/** `GET /opnames/:id` — boleh dipanggil dalam transaksi (langsung setelah create). */
export async function getOpname(id: number, transaction?: Transaction): Promise<OpnameDetail> {
  const head = (await sequelize.query(`${SELECT_OPNAME} WHERE o.id = $id`, {
    bind: { id },
    type: QueryTypes.SELECT,
    transaction,
  })) as RawOpnameRow[];
  if (!head[0]) throw new ApiError('NOT_FOUND', `Opname id=${id} tidak ditemukan`);

  const items = (await sequelize.query(`${SELECT_ITEM} WHERE i.opname_id = $id ORDER BY i.id ASC`, {
    bind: { id },
    type: QueryTypes.SELECT,
    transaction,
  })) as OpnameItemRow[];

  return { ...toOpnameRow(head[0]), items };
}

/* ============================== tulis opname ============================== */

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
  transaction: Transaction,
  productId: number,
  batchId: number | null,
  lock: boolean,
): Promise<SystemSnapshot> {
  if (batchId) {
    // `lock` di sini selalu true dari createOpname (satu-satunya pemanggil).
    const batch = await StockBatch.findOne({
      where: { id: batchId, product_id: productId },
      transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!batch) {
      throw new ApiError('BATCH_NOT_FOUND', `Batch id=${batchId} bukan batch dari produk id=${productId}`);
    }
    return {
      batch_id: batchId,
      system_qty: batch.qty_remaining,
      system_qty_damaged: batch.qty_damaged,
    };
  }

  // Tanpa batch -> agregat seluruh batch produk (snapshotted per produk, bukan per batch).
  const good = await StockBatch.sum('qty_remaining', { where: { product_id: productId }, transaction });
  const damaged = await StockBatch.sum('qty_damaged', { where: { product_id: productId }, transaction });
  return {
    batch_id: null,
    system_qty: Number(good ?? 0),
    system_qty_damaged: Number(damaged ?? 0),
  };
}

/**
 * Batch tujuan koreksi. `forRemoval` (selisih negatif barang rusak) hanya memilih batch
 * yang benar-benar punya barang rusak, supaya tidak rely on pesan error trigger.
 */
async function pickAdjustmentBatch(
  transaction: Transaction,
  productId: number,
  forRemoval: boolean,
): Promise<number | null> {
  const batch = await StockBatch.findOne({
    where: { product_id: productId, ...(forRemoval ? { qty_damaged: { [Op.gt]: 0 } } : {}) },
    // expired_date NULLS LAST adalah default PostgreSQL untuk ASC.
    order: [['expired_date', 'ASC'], ['id', 'ASC']],
    transaction,
  });
  return batch?.id ?? null;
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
export async function createOpname(input: OpnameInput, userId: number): Promise<OpnameDetail> {
  // Satu produk hanya boleh satu baris per opname (constraint DB hanya unik per
  // (opname_id, product_id, batch_id) — validasi aplikasi dibuat lebih ketat
  // supaya kasir tidak salah input dobel tanpa sadar).
  const seen = new Set<number>();
  for (const it of input.items) {
    if (seen.has(it.product_id)) {
      throw new ApiError('VALIDATION_ERROR', `Produk id=${it.product_id} muncul lebih dari sekali pada opname yang sama`);
    }
    seen.add(it.product_id);
  }

  try {
    return await withOrmTx(async (transaction) => {
      const opnameNo = await nextDocNo(transaction, 'opname', env.businessTz);
      const opname = await StockOpname.create(
        { opname_no: opnameNo, note: input.note ?? null, created_by: userId },
        { transaction },
      );

      for (const item of input.items) {
        const product = await Product.scope('withInactive').findByPk(item.product_id, {
          attributes: ['id', 'name'],
          transaction,
        });
        if (!product) {
          throw new ApiError('VALIDATION_ERROR', `Produk id=${item.product_id} tidak ditemukan`);
        }

        // Snapshot sistem: GOOD (qty_remaining) + RUSAK (qty_damaged), opsional per batch.
        const sys = await readSystemSnapshot(transaction, item.product_id, item.batch_id ?? null, true);
        const physicalDamaged =
          item.physical_qty_damaged === undefined || item.physical_qty_damaged === null
            ? sys.system_qty_damaged
            : item.physical_qty_damaged;

        const diff = round3(item.physical_qty - sys.system_qty);
        const damagedDiff = round3(physicalDamaged - sys.system_qty_damaged);

        await StockOpnameItem.create(
          {
            opname_id: opname.id,
            product_id: item.product_id,
            batch_id: sys.batch_id,
            system_qty: sys.system_qty,
            physical_qty: item.physical_qty,
            system_qty_damaged: sys.system_qty_damaged,
            physical_qty_damaged: physicalDamaged,
            cause: item.cause ?? null,
            note: item.note ?? null,
          },
          { transaction },
        );

        if (diff !== 0) {
          const target = sys.batch_id ?? (await pickAdjustmentBatch(transaction, item.product_id, false));
          if (target === null) {
            throw new ApiError(
              'VALIDATION_ERROR',
              `Selisih opname produk "${product.name}" tidak dapat dikoreksi: belum ada batch stok`,
            );
          }
          const cap = await StockBatch.findByPk(target, { transaction, lock: transaction.LOCK.UPDATE });
          if (!cap) {
            throw new ApiError('VALIDATION_ERROR', `Batch id=${target} tidak ditemukan saat koreksi opname`);
          }
          if (diff > 0 && cap.qty_remaining + diff > cap.qty_received) {
            throw new ApiError(
              'VALIDATION_ERROR',
              `Selisih opname +${diff} melebihi kapasitas batch (sisa ${cap.qty_remaining} / diterima ${cap.qty_received}). ` +
                `Buat batch pembelian baru untuk mencatat kelebihan stok.`,
            );
          }

          await StockMovement.create(
            {
              product_id: item.product_id,
              batch_id: target,
              movement_type: 'ADJUSTMENT',
              qty_change: diff,
              unit_cost: cap.qty_remaining > 0 ? cap.unit_cost : 0,
              reference_type: 'OPNAME',
              reference_id: opname.id,
              note: `Koreksi opname ${opnameNo}: system ${sys.system_qty} -> fisik ${item.physical_qty}`,
              created_by: userId,
              condition: 'GOOD',
            },
            { transaction },
          );
        }

        if (damagedDiff !== 0) {
          // Barang rusak tidak ikut kapasitas batch; trigger yang menjaga qty_damaged >= 0.
          const target =
            sys.batch_id ?? (await pickAdjustmentBatch(transaction, item.product_id, damagedDiff < 0));
          if (target === null) {
            throw new ApiError(
              'VALIDATION_ERROR',
              `Selisih opname barang rusak produk "${product.name}" tidak dapat dikoreksi: belum ada batch stok`,
            );
          }
          const cap = await StockBatch.findByPk(target, { transaction, lock: transaction.LOCK.UPDATE });
          if (!cap) {
            throw new ApiError('VALIDATION_ERROR', `Batch id=${target} tidak ditemukan saat koreksi opname rusak`);
          }
          if (damagedDiff < 0 && cap.qty_damaged + damagedDiff < 0) {
            throw new ApiError(
              'DAMAGED_QTY_INSUFFICIENT',
              `Selisih opname barang rusak ${damagedDiff} melebihi stok rusak yang tercatat pada batch #${target} (${cap.qty_damaged})`,
            );
          }

          await StockMovement.create(
            {
              product_id: item.product_id,
              batch_id: target,
              movement_type: 'ADJUSTMENT',
              qty_change: damagedDiff,
              unit_cost: cap.unit_cost,
              reference_type: 'OPNAME',
              reference_id: opname.id,
              note:
                `Koreksi opname ${opnameNo} (barang rusak): system ${sys.system_qty_damaged} -> fisik ${physicalDamaged}` +
                (item.cause ? ` [${item.cause}]` : ''),
              created_by: userId,
              condition: 'RUSAK',
            },
            { transaction },
          );
        }
      }

      return getOpname(opname.id, transaction);
    }, 'opname');
  } catch (err) {
    throw mapOrmError(err);
  }
}