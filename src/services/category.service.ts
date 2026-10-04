import { pool } from '../config/db.js';
import { ApiError, notFound } from '../utils/errors.js';

export interface CategoryRow {
  id: number;
  name: string;
  id_type: number | null;
  type_name: string | null;
  is_active: boolean;
  product_count?: number;
}

/** Catatan: baris lama bisa punya is_active NULL -> dianggap aktif (COALESCE). */
export async function listCategories(activeOnly = false): Promise<CategoryRow[]> {
  const res = await pool.query<CategoryRow>(
    `SELECT c.id, c.name, c.id_type, t.name AS type_name, COALESCE(c.is_active, true) AS is_active,
            (SELECT count(*)::int FROM product p WHERE p.category_id = c.id) AS product_count
       FROM product_category c
       LEFT JOIN product_type t ON t.id = c.id_type
      ${activeOnly ? 'WHERE COALESCE(c.is_active, true) = true' : ''}
      ORDER BY c.name ASC`,
  );
  return res.rows;
}

export async function createCategory(name: string, idType?: number | null): Promise<CategoryRow> {
  const dup = await pool.query(`SELECT id FROM product_category WHERE lower(name) = lower($1)`, [name]);
  if (dup.rows.length > 0) {
    throw new ApiError('DUPLICATE', `Kategori "${name}" sudah ada (id=${dup.rows[0]?.id})`);
  }
  const res = await pool.query<{ id: number }>(
    `INSERT INTO product_category (name, id_type, is_active) VALUES ($1, $2, true) RETURNING id`,
    [name, idType ?? null],
  );
  return getCategory(res.rows[0]!.id);
}

export async function getCategory(id: number): Promise<CategoryRow> {
  const res = await pool.query<CategoryRow>(
    `SELECT c.id, c.name, c.id_type, t.name AS type_name, COALESCE(c.is_active, true) AS is_active
       FROM product_category c LEFT JOIN product_type t ON t.id = c.id_type
      WHERE c.id = $1`,
    [id],
  );
  if (!res.rows[0]) throw notFound(`Kategori id=${id} tidak ditemukan`);
  return res.rows[0];
}

export async function updateCategory(id: number, patch: { name?: string; id_type?: number | null; is_active?: boolean }): Promise<CategoryRow> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.id_type !== undefined) {
    params.push(patch.id_type);
    sets.push(`id_type = $${params.length}`);
  }
  if (patch.is_active !== undefined) {
    params.push(patch.is_active);
    sets.push(`is_active = $${params.length}`);
  }
  if (sets.length === 0) throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');

  params.push(id);
  const res = await pool.query(`UPDATE product_category SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params as never[]);
  if (res.rowCount === 0) throw notFound(`Kategori id=${id} tidak ditemukan`);
  return getCategory(id);
}

/* ---------------------------- product_type ---------------------------- */

export interface ProductTypeRow {
  id: number;
  name: string;
  is_active: boolean;
}

export async function listProductTypes(): Promise<ProductTypeRow[]> {
  const res = await pool.query<ProductTypeRow>(
    `SELECT id, name, COALESCE(is_active, true) AS is_active FROM product_type ORDER BY name ASC`,
  );
  return res.rows;
}

export async function createProductType(name: string): Promise<ProductTypeRow> {
  const dup = await pool.query(`SELECT id FROM product_type WHERE lower(name) = lower($1)`, [name]);
  if (dup.rows.length > 0) {
    throw new ApiError('DUPLICATE', `Tipe "${name}" sudah ada (id=${dup.rows[0]?.id})`);
  }
  const res = await pool.query<ProductTypeRow>(
    `INSERT INTO product_type (name, is_active) VALUES ($1, true)
     RETURNING id, name, COALESCE(is_active, true) AS is_active`,
    [name],
  );
  return res.rows[0]!;
}
