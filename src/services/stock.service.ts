import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

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

/**
 * Query stok TANPA view (fase.md section 0, wajib dipakai persis pola ini):
 *
 *   SELECT p.id, p.sku, p.barcode, p.name, p.unit,
 *          COALESCE(SUM(b.qty_remaining), 0)::numeric(14,3) AS qty_on_hand,
 *          MIN(b.expired_date) AS nearest_expiry
 *   FROM product p LEFT JOIN stock_batches b ON b.product_id = p.id
 *   GROUP BY p.id, p.sku, p.barcode, p.name, p.unit;
 *
 * Aplikasi tidak pernah menghitung/mutasi stok: angka ini murni hasil trigger DB.
 * Kolom tambahan (filter) hanya WHERE/HAVING, tidak mengubah perhitungan.
 * v2: `qty_damaged` (barang rusak karantina) ikut ditampilkan sebagai kolom tambahan;
 * `qty_on_hand` tetap HANYA barang GOOD karena itu yang boleh terjual POS.
 */
export async function getStock(params: {
  product_id?: number;
  q?: string;
  category_id?: number;
  active_only?: boolean;
  expiring_in_days?: number;
  in_stock_only?: boolean;
  damaged_only?: boolean;
  limit: number;
  offset: number;
}): Promise<ProductStockRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];
  const having: string[] = [];

  if (params.product_id !== undefined) {
    args.push(params.product_id);
    where.push(`p.id = $${args.length}`);
  }
  if (params.category_id !== undefined) {
    args.push(params.category_id);
    where.push(`p.category_id = $${args.length}`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`(p.name ILIKE $${args.length} OR p.sku ILIKE $${args.length} OR p.barcode ILIKE $${args.length})`);
  }
  if (params.active_only) {
    where.push('p.is_active = true');
  }

  // Filter near-expiry harus di HAVING karena berbasis agregat MIN(expired_date).
  if (params.expiring_in_days !== undefined) {
    args.push(env.businessTz, params.expiring_in_days);
    const tzIdx = args.length - 1;
    const daysIdx = args.length;
    having.push(
      `MIN(b.expired_date) IS NOT NULL AND MIN(b.expired_date) <= (now() AT TIME ZONE $${tzIdx})::date + $${daysIdx}::int`,
    );
  }
  if (params.in_stock_only) {
    having.push('COALESCE(SUM(b.qty_remaining), 0) > 0');
  }
  // Hanya produk yang punya barang rusak karantina (untuk layar "siap diretur").
  if (params.damaged_only) {
    having.push('COALESCE(SUM(b.qty_damaged), 0) > 0');
  }

  args.push(params.limit, params.offset);
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
     LIMIT $${args.length - 1} OFFSET $${args.length}`;

  const res = await pool.query<ProductStockRow>(sql, args as never[]);
  return res.rows;
}

export async function getProductStock(productId: number): Promise<ProductStockRow> {
  const rows = await getStock({ product_id: productId, limit: 1, offset: 0 });
  const row = rows[0];
  if (!row) {
    const exists = await pool.query(`SELECT 1 FROM product WHERE id = $1`, [productId]);
    if (!exists.rows[0]) throw new ApiError('NOT_FOUND', `Produk id=${productId} tidak ditemukan`);
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
  const args: unknown[] = [];
  const where: string[] = ['b.qty_damaged > 0'];

  if (params.product_id !== undefined) {
    args.push(params.product_id);
    where.push(`b.product_id = $${args.length}`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`(p.name ILIKE $${args.length} OR p.sku ILIKE $${args.length} OR b.batch_code ILIKE $${args.length})`);
  }

  args.push(params.limit, params.offset);
  const res = await pool.query<DamagedStockRow>(
    `SELECT b.id AS batch_id, b.batch_code, p.id AS product_id, p.name AS product_name, p.sku, p.unit,
            b.qty_damaged, b.unit_cost,
            (b.qty_damaged * b.unit_cost)::numeric(14,2) AS value,
            b.expired_date, b.supplier, b.received_at
       FROM stock_batches b
       JOIN product p ON p.id = b.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.expired_date ASC NULLS LAST, b.id ASC
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}

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

/** Ledger pergerakan stok (append-only, tidak pernah UPDATE/DELETE). */
export async function listMovements(params: {
  product_id?: number;
  batch_id?: number;
  type?: string;
  reference_type?: string;
  reference_id?: number;
  condition?: string;
  limit: number;
  offset: number;
}): Promise<MovementRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];

  if (params.product_id !== undefined) {
    args.push(params.product_id);
    where.push(`m.product_id = $${args.length}`);
  }
  if (params.batch_id !== undefined) {
    args.push(params.batch_id);
    where.push(`m.batch_id = $${args.length}`);
  }
  if (params.type) {
    args.push(params.type);
    where.push(`m.movement_type = $${args.length}`);
  }
  if (params.reference_type) {
    args.push(params.reference_type);
    where.push(`m.reference_type = $${args.length}`);
  }
  if (params.reference_id !== undefined) {
    args.push(params.reference_id);
    where.push(`m.reference_id = $${args.length}`);
  }
  // Filter kondisi: pisahkan jejak barang sellable vs barang rusak karantina.
  if (params.condition) {
    args.push(params.condition);
    where.push(`m.condition = $${args.length}`);
  }

  args.push(params.limit, params.offset);
  const res = await pool.query<MovementRow>(
    `SELECT m.id, m.product_id, p.name AS product_name, m.batch_id, b.batch_code,
            m.movement_type, m.qty_change, m.unit_cost, m.reference_type, m.reference_id,
            m.note, m.created_by, u.username AS created_by_name, m.created_at, m.condition
       FROM stock_movements m
       JOIN product p ON p.id = m.product_id
       LEFT JOIN stock_batches b ON b.id = m.batch_id
       LEFT JOIN user_account u ON u.id = m.created_by
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.id DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args as never[],
  );
  return res.rows;
}
