import { pool } from '../config/db.js';
import { ApiError, notFound } from '../utils/errors.js';

export interface ProductRow {
  id: number;
  sku: string | null;
  barcode: string | null;
  name: string;
  unit: string | null;
  category_id: number | null;
  category_name: string | null;
  description: string | null;
  harga_beli: number | null;
  harga_jual: number | null;
  attributes: Record<string, unknown>;
  is_active: boolean;
  min_stock: number;
  unit_conversions: Record<string, number> | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PRODUCT = `
  SELECT p.id, p.sku, p.barcode, p.name, p.unit, p.category_id, c.name AS category_name,
         p.desctiption AS description, p.harga_beli, p.harga_jual, p.attributes, p.is_active,
         p.min_stock, p.unit_conversions,
         p.created_at, p.updated_at
    FROM product p
    LEFT JOIN product_category c ON c.id = p.category_id
`;

export interface ProductListQuery {
  q?: string;
  category_id?: number;
  active?: boolean;
  limit: number;
  offset: number;
}

export async function listProducts(q: ProductListQuery): Promise<ProductRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (q.q) {
    params.push(`%${q.q}%`);
    where.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`);
  }
  if (q.category_id !== undefined) {
    params.push(q.category_id);
    where.push(`p.category_id = $${params.length}`);
  }
  if (q.active !== undefined) {
    params.push(q.active);
    where.push(`p.is_active = $${params.length}`);
  }

  params.push(q.limit, q.offset);
  const sql = `${SELECT_PRODUCT}
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.name ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const res = await pool.query<ProductRow>(sql, params as never[]);
  return res.rows;
}

export interface ProductInput {
  sku?: string | null;
  barcode?: string | null;
  name: string;
  unit?: string;
  category_id?: number | null;
  description?: string | null;
  harga_beli?: number | null;
  harga_jual?: number | null;
  attributes?: Record<string, unknown>;
  min_stock?: number | null;
  unit_conversions?: Record<string, number> | null;
  is_active?: boolean;
}

export async function createProduct(input: ProductInput): Promise<ProductRow> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO product (sku, barcode, name, unit, category_id, desctiption, harga_beli, harga_jual, attributes, is_active, min_stock, unit_conversions, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10, true), COALESCE($11, 0), $12::jsonb, now())
     RETURNING id`,
    [
      input.sku ?? null,
      input.barcode ?? null,
      input.name,
      input.unit ?? 'pcs',
      input.category_id ?? null,
      input.description ?? null,
      input.harga_beli ?? null,
      input.harga_jual ?? null,
      JSON.stringify(input.attributes ?? {}),
      input.is_active ?? true,
      input.min_stock ?? 0,
      input.unit_conversions ? JSON.stringify(input.unit_conversions) : null,
    ],
  );
  return getProduct(res.rows[0]!.id);
}

export async function getProduct(id: number): Promise<ProductRow> {
  const res = await pool.query<ProductRow>(`${SELECT_PRODUCT} WHERE p.id = $1`, [id]);
  if (!res.rows[0]) throw notFound(`Produk id=${id} tidak ditemukan`);
  return res.rows[0];
}

/** Patch semantics: hanya kolom yang dikirim yang diubah (COALESCE dengan NULL check eksplisit). */
export async function updateProduct(id: number, input: Partial<ProductInput>): Promise<ProductRow> {
  const sets: string[] = [];
  const params: unknown[] = [];

  const push = (col: string, value: unknown, cast = '') => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };

  if (input.name !== undefined) push('name', input.name);
  if (input.sku !== undefined) push('sku', input.sku);
  if (input.barcode !== undefined) push('barcode', input.barcode);
  if (input.unit !== undefined) push('unit', input.unit);
  if (input.category_id !== undefined) push('category_id', input.category_id);
  if (input.description !== undefined) push('desctiption', input.description);
  if (input.harga_beli !== undefined) push('harga_beli', input.harga_beli);
  if (input.harga_jual !== undefined) push('harga_jual', input.harga_jual);
  if (input.attributes !== undefined) push('attributes', JSON.stringify(input.attributes), '::jsonb');
  if (input.min_stock !== undefined) push('min_stock', input.min_stock);
  if (input.unit_conversions !== undefined) push('unit_conversions', input.unit_conversions ? JSON.stringify(input.unit_conversions) : null, '::jsonb');
  if (input.is_active !== undefined) push('is_active', input.is_active);

  if (sets.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');
  }

  sets.push('updated_at = now()');
  params.push(id);

  const res = await pool.query(`UPDATE product SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params as never[]);
  if (res.rowCount === 0) throw notFound(`Produk id=${id} tidak ditemukan`);
  return getProduct(id);
}

/**
 * Soft delete (FASE 1): produk nonaktif, histori stok & ledger tetap utuh.
 * Hard delete ditolak bila sudah pernah dipakai di batch/sale (FK) -> jadi soft delete
 * adalah perilaku yang benar secara audit.
 */
export async function deactivateProduct(id: number): Promise<ProductRow> {
  const res = await pool.query(`UPDATE product SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`, [id]);
  if (res.rowCount === 0) throw notFound(`Produk id=${id} tidak ditemukan`);
  return getProduct(id);
}
