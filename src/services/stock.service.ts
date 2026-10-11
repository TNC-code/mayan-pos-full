import { Op, QueryTypes, type Includeable } from 'sequelize';
import { ApiError } from '../utils/errors.js';
import { isoDateOnly } from '../utils/dates.js';
import { env } from '../config/env.js';
import { Product, StockBatch, StockMovement, UserAccount, sequelize } from '../models/index.js';

/**
 * Stok per produk & ledger pergerakan (MP-3).
 *
 * Dua jalur baca yang disengaja (hybrid §D4):
 *  - `listStock` = agregat per produk (SUM qty_remaining/qty_damaged + MIN expired
 *    per produk + filter agregat `expiring_in_days`/`in_stock_only`/`damaged_only`).
 *    SQL-nya disalin PERSIS dari versi raw SQL lama karena (a) sudah teruji,
 *    (b) `HAVING` atas agregat jauh lebih ringkas daripada builder ORM.
 *    Yang berubah hanya transport: `pool.query` -> `sequelize.query` dengan
 *    `bind` parameter (tanpa interpolation string).
 *  - `listMovements` = ledger append-only, dibaca lewat model `StockMovement`
 *    + include produk/batch/user (satu join, tanpa agregat).
 *
 * Aplikasi tidak pernah menghitung/mutasi stok: semua angka murni hasil trigger
 * `trg_stock_movement_apply` (D3). `qty_on_hand` hanya GOOD karena itu yang boleh
 * terjual POS; `qty_damaged` = barang rusak karantina; `physical_total` = keduanya.
 */

export interface ProductStockRow {
  product_id: number;
  sku: string | null;
  barcode: string | null;
  name: string;
  unit: string | null;
  qty_on_hand: number;
  /** Barang rusak (karantina): hasil refund/void RUSAK, belum diretur ke distributor. */
  qty_damaged: number;
  /** qty_on_hand + qty_damaged = seluruh barang yang masih ada di gudang. */
  physical_total: number;
  nearest_expiry: string | null;
}

export interface StockListQuery {
  product_id?: number;
  q?: string;
  category_id?: number;
  active_only?: boolean;
  expiring_in_days?: number;
  in_stock_only?: boolean;
  damaged_only?: boolean;
  limit: number;
  offset: number;
}

/**
 * Query stok TANPA view (fase.md section 0, wajib dipakai persis pola ini):
 *
 *   SELECT p.id, p.sku, p.barcode, p.name, p.unit,
 *          COALESCE(SUM(b.qty_remaining), 0)::numeric(14,3) AS qty_on_hand,
 *          MIN(b.expired_date) AS nearest_expiry
 *   FROM product p LEFT JOIN stock_batches b ON b.product_id = p.id
 *   GROUP BY p.id, p.sku, p.barcode, p.name, p.unit;
 *
 * Kolom tambahan (filter) hanya WHERE/HAVING, tidak mengubah perhitungan.
 */
export async function listStock(params: StockListQuery): Promise<ProductStockRow[]> {
  const binds: unknown[] = [];
  const where: string[] = [];
  const having: string[] = [];
  const push = (value: unknown): string => {
    binds.push(value);
    return `$${binds.length}`;
  };

  if (params.product_id !== undefined) where.push(`p.id = ${push(params.product_id)}`);
  if (params.category_id !== undefined) where.push(`p.category_id = ${push(params.category_id)}`);
  if (params.q) {
    const like = push(`%${params.q}%`);
    where.push(`(p.name ILIKE ${like} OR p.sku ILIKE ${like} OR p.barcode ILIKE ${like})`);
  }
  if (params.active_only) where.push('p.is_active = true');

  // Filter near-expiry harus di HAVING karena berbasis agregat MIN(expired_date).
  if (params.expiring_in_days !== undefined) {
    const tz = push(env.businessTz);
    const days = push(params.expiring_in_days);
    having.push(`MIN(b.expired_date) IS NOT NULL AND MIN(b.expired_date) <= (now() AT TIME ZONE ${tz})::date + ${days}::int`);
  }
  if (params.in_stock_only) having.push('COALESCE(SUM(b.qty_remaining), 0) > 0');
  // Hanya produk yang punya barang rusak karantina (untuk layar "siap diretur").
  if (params.damaged_only) having.push('COALESCE(SUM(b.qty_damaged), 0) > 0');

  const limitIdx = binds.push(params.limit);
  const offsetIdx = binds.push(params.offset);

  const sql = `
    SELECT p.id AS product_id, p.sku, p.barcode, p.name, p.unit,
           COALESCE(SUM(b.qty_remaining), 0)::numeric(14,3) AS qty_on_hand,
           COALESCE(SUM(b.qty_damaged), 0)::numeric(14,3) AS qty_damaged,
           (COALESCE(SUM(b.qty_remaining), 0) + COALESCE(SUM(b.qty_damaged), 0))::numeric(14,3) AS physical_total,
           MIN(b.expired_date) AS nearest_expiry
      FROM product p
      LEFT JOIN stock_batches b ON b.product_id = p.id
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     GROUP BY p.id, p.sku, p.barcode, p.name, p.unit
     ${having.length > 0 ? `HAVING ${having.join(' AND ')}` : ''}
     ORDER BY p.name ASC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const rows = (await sequelize.query(sql, { bind: binds, type: QueryTypes.SELECT })) as Array<
    Omit<ProductStockRow, 'nearest_expiry'> & { nearest_expiry: string | null }
  >;
  return rows.map((row) => ({ ...row, nearest_expiry: isoDateOnly(row.nearest_expiry) }));
}

/** `GET /stock/products/:id` — satu baris; produk tidak ada -> 404. */
export async function getProductStock(productId: number): Promise<ProductStockRow> {
  const rows = await listStock({ product_id: productId, limit: 1, offset: 0 });
  const row = rows[0];
  if (!row) {
    const exists = await Product.scope('withInactive').findByPk(productId, { attributes: ['id'] });
    if (!exists) throw new ApiError('NOT_FOUND', `Produk id=${productId} tidak ditemukan`);
  }
  return row!;
}

/* ======================= stok rusak siap diretur (UC-B) ======================= */

export interface DamagedStockRow {
  batch_id: number;
  batch_code: string;
  product_id: number;
  product_name: string;
  sku: string | null;
  unit: string | null;
  qty_damaged: number;
  unit_cost: number;
  /** qty_damaged × unit_cost: nilai rupiah barang rusak yang menggantung di gudang. */
  value: number;
  expired_date: string | null;
  supplier: string | null;
  received_at: string;
}

/**
 * Daftar stok rusak per BATCH (bukan per produk) karena retur distributor selalu
 * merujuk batch asal barang: batch_id + qty_damaged + unit_cost = siap pakai
 * untuk body POST /supplier-returns.
 */
export async function getDamagedStock(params: {
  product_id?: number;
  q?: string;
  limit: number;
  offset: number;
}): Promise<DamagedStockRow[]> {
  const binds: unknown[] = [];
  const where: string[] = ['b.qty_damaged > 0'];

  if (params.product_id !== undefined) {
    binds.push(params.product_id);
    where.push(`b.product_id = $${binds.length}`);
  }
  if (params.q) {
    binds.push(`%${params.q}%`);
    where.push(`(p.name ILIKE $${binds.length} OR p.sku ILIKE $${binds.length} OR b.batch_code ILIKE $${binds.length})`);
  }

  binds.push(params.limit, params.offset);
  const rows = (await sequelize.query(
    `SELECT b.id AS batch_id, b.batch_code, p.id AS product_id, p.name AS product_name, p.sku, p.unit,
            b.qty_damaged, b.unit_cost,
            (b.qty_damaged * b.unit_cost)::numeric(14,2) AS value,
            b.expired_date, b.supplier, b.received_at
       FROM stock_batches b
       JOIN product p ON p.id = b.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.expired_date ASC NULLS LAST, b.id ASC
      LIMIT $${binds.length - 1} OFFSET $${binds.length}`,
    { bind: binds, type: QueryTypes.SELECT },
  )) as Array<Omit<DamagedStockRow, 'expired_date' | 'received_at'> & { expired_date: string | null; received_at: Date }>;

  return rows.map((row) => ({
    ...row,
    expired_date: isoDateOnly(row.expired_date),
    received_at: new Date(row.received_at).toISOString(),
  }));
}

/* ============================ ledger pergerakan stok ============================ */

export interface MovementRow {
  id: number;
  product_id: number;
  product_name: string | null;
  batch_id: number | null;
  batch_code: string | null;
  movement_type: string;
  qty_change: number;
  unit_cost: number;
  reference_type: string;
  reference_id: number | null;
  note: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  /** GOOD = barang sellable; RUSAK = karantina (retur customer/void/supplier return). */
  condition: 'GOOD' | 'RUSAK';
}

export interface MovementListQuery {
  product_id?: number;
  batch_id?: number;
  type?: string;
  reference_type?: string;
  reference_id?: number;
  condition?: string;
  limit: number;
  offset: number;
}

/**
 * Ledger pergerakan stok (append-only, tidak pernah UPDATE/DELETE).
 * Filter `condition` memisahkan jejak barang sellable vs barang rusak karantina.
 */
export async function listMovements(params: MovementListQuery): Promise<MovementRow[]> {
  const conditions: Record<string, unknown>[] = [];
  if (params.product_id !== undefined) conditions.push({ product_id: params.product_id });
  if (params.batch_id !== undefined) conditions.push({ batch_id: params.batch_id });
  if (params.type) conditions.push({ movement_type: params.type });
  if (params.reference_type) conditions.push({ reference_type: params.reference_type });
  if (params.reference_id !== undefined) conditions.push({ reference_id: params.reference_id });
  if (params.condition) conditions.push({ condition: params.condition });

  const includes: Includeable[] = [
    { model: Product.scope('withInactive'), as: 'product', attributes: ['id', 'name'], required: true },
    { model: StockBatch, as: 'batch', attributes: ['id', 'batch_code'], required: false },
    { model: UserAccount, as: 'creator', attributes: ['id', 'username'], required: false },
  ];

  const rows = await StockMovement.findAll({
    where: { [Op.and]: conditions },
    include: includes,
    subQuery: false,
    order: [['id', 'DESC']],
    limit: params.limit,
    offset: params.offset,
  });

  return (rows as unknown as Array<
    StockMovement & {
      product?: { id: number; name: string | null } | null;
      batch?: { id: number; batch_code: string } | null;
      creator?: { id: number; username: string } | null;
    }
  >).map((row) => ({
    id: row.id,
    product_id: row.product_id,
    product_name: row.product?.name ?? null,
    batch_id: row.batch_id,
    batch_code: row.batch?.batch_code ?? null,
    movement_type: row.movement_type,
    qty_change: row.qty_change,
    unit_cost: row.unit_cost,
    reference_type: row.reference_type,
    reference_id: row.reference_id,
    note: row.note,
    created_by: row.created_by,
    created_by_name: row.creator?.username ?? null,
    created_at: new Date(row.created_at).toISOString(),
    condition: row.condition,
  }));
}
