import { Op, col, fn, where, type Includeable } from 'sequelize';
import { ApiError, notFound } from '../utils/errors.js';
import { mapOrmError } from '../utils/orm-errors.js';
import { Product, ProductCategory, ProductType } from '../models/index.js';

/**
 * Kategori & tipe produk di atas Sequelize (MP-2).
 *
 * Perilaku DISAMAKAN PERSIS dengan versi raw SQL lama
 * (`git show HEAD~1:src/services/category.service.ts`) supaya `fe/` tidak melihat
 * perbedaan apa pun:
 *  - `is_active` NULL -> dianggap aktif (`?? true`, setara `COALESCE(is_active, true)`);
 *  - `product_count` = jumlah produk pada kategori itu **termasuk produk nonaktif**
 *    (SQL lama memakai subquery `SELECT count(*) FROM product WHERE category_id = c.id`
 *    tanpa filter `is_active`);
 *  - urutan list `name ASC`; `active_only=true` hanya menyaring yang aktif;
 *  - duplikat nama (case-insensitive) -> `DUPLICATE` 409 dengan pesan yang sama;
 *  - patch kosong -> `VALIDATION_ERROR` "Tidak ada kolom yang akan diubah";
 *  - id tak ada -> `NOT_FOUND` 404 ("Kategori id=… tidak ditemukan").
 *
 * Catatan performa: `product_count` dihitung dengan SATU query agregat
 * (`GROUP BY category_id`) lalu dipakai sebagai map, jadi tetap 2 query total —
 * bukan subquery per baris dan bukan N+1.
 *
 * Deviasi yang disengaja (mengikuti kontrak, bukan perilaku lama):
 * `PATCH /categories/:id` sekarang menghormati `type_id` sesuai `openapi.yaml`
 * & `schemas.ts`. Service lama membaca `patch.id_type`, sementara
 * `middleware/validate.ts` mengganti `req.body` dengan hasil parse zod yang hanya
 * memuat `type_id` — sehingga `type_id` selalu terbuang dan request yang hanya
 * berisi `type_id` berakhir 400 "Tidak ada kolom yang akan diubah". Kunci
 * `id_type` tetap diterima (dipakai pemanggil internal) agar tidak ada yang rusak.
 */

export interface CategoryRow {
  id: number;
  name: string | null;
  id_type: number | null;
  type_name: string | null;
  is_active: boolean;
  product_count?: number;
}

const WITH_TYPE: Includeable = {
  model: ProductType,
  as: 'type',
  attributes: ['id', 'name'],
  required: false,
};

type CategoryWithType = ProductCategory & { type?: { id: number; name: string | null } | null };

function toCategoryRow(row: CategoryWithType, productCount?: number): CategoryRow {
  return {
    id: row.id,
    name: row.name ?? null,
    id_type: row.id_type,
    type_name: row.type?.name ?? null,
    is_active: row.is_active ?? true,
    ...(productCount === undefined ? {} : { product_count: productCount }),
  };
}

/** Jumlah produk per kategori, termasuk produk nonaktif (parity dengan subquery SQL lama). */
async function countProductsPerCategory(): Promise<Map<number, number>> {
  const rows = await Product.scope('withInactive').findAll({
    attributes: ['category_id', [fn('COUNT', col('id')), 'total']],
    where: { category_id: { [Op.ne]: null } },
    group: ['category_id'],
    raw: true,
  });
  const counts = new Map<number, number>();
  for (const row of rows as unknown as Array<{ category_id: number; total: number | string }>) {
    counts.set(row.category_id, Number(row.total));
  }
  return counts;
}

/** Baris lama bisa punya is_active NULL -> dianggap aktif (COALESCE). */
export async function listCategories(activeOnly = false): Promise<CategoryRow[]> {
  const rows = await ProductCategory.findAll({
    where: activeOnly ? { [Op.or]: [{ is_active: true }, { is_active: null }] } : undefined,
    include: [WITH_TYPE],
    order: [['name', 'ASC']],
  });
  const counts = await countProductsPerCategory();
  return (rows as unknown as CategoryWithType[]).map((row) => toCategoryRow(row, counts.get(row.id) ?? 0));
}

export async function getCategory(id: number): Promise<CategoryRow> {
  const row = await ProductCategory.findByPk(id, { include: [WITH_TYPE] });
  if (!row) throw notFound(`Kategori id=${id} tidak ditemukan`);
  return toCategoryRow(row as unknown as CategoryWithType);
}

/** Nama kategori unik secara case-insensitive — dijaga aplikasi (tidak ada UNIQUE index). */
async function findCategoryByNameCi(name: string): Promise<ProductCategory | null> {
  return ProductCategory.findOne({
    where: where(fn('lower', col('name')), name.toLowerCase()),
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
}

export async function createCategory(name: string, idType?: number | null): Promise<CategoryRow> {
  const dup = await findCategoryByNameCi(name);
  if (dup) {
    throw new ApiError('DUPLICATE', `Kategori "${name}" sudah ada (id=${dup.id})`);
  }
  try {
    const created = await ProductCategory.create({ name, id_type: idType ?? null, is_active: true });
    return await getCategory(created.id);
  } catch (err) {
    // Balapan dua create tanpa nama sama (tidak ada UNIQUE index) -> tetap 409 di kode apa pun.
    throw mapOrmError(err);
  }
}

export interface CategoryPatch {
  name?: string;
  /** Nama field kontrak API (`openapi.yaml` + `schemas.ts`). */
  type_id?: number | null;
  /** Nama kolom DB; tetap diterima untuk pemanggil internal. */
  id_type?: number | null;
  is_active?: boolean;
}

export async function updateCategory(id: number, patch: CategoryPatch): Promise<CategoryRow> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.type_id !== undefined) values.id_type = patch.type_id;
  if (patch.id_type !== undefined) values.id_type = patch.id_type;
  if (patch.is_active !== undefined) values.is_active = patch.is_active;

  if (Object.keys(values).length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');
  }

  const row = await ProductCategory.findByPk(id);
  if (!row) throw notFound(`Kategori id=${id} tidak ditemukan`);
  try {
    await row.update(values);
  } catch (err) {
    throw mapOrmError(err);
  }
  return getCategory(id);
}

/* ---------------------------- product_type ---------------------------- */

export interface ProductTypeRow {
  id: number;
  name: string | null;
  is_active: boolean;
}

export async function listProductTypes(): Promise<ProductTypeRow[]> {
  const rows = await ProductType.findAll({ order: [['name', 'ASC']] });
  return rows.map((row) => ({ id: row.id, name: row.name ?? null, is_active: row.is_active ?? true }));
}

export async function createProductType(name: string): Promise<ProductTypeRow> {
  const dup = await ProductType.findOne({
    where: where(fn('lower', col('name')), name.toLowerCase()),
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  if (dup) {
    throw new ApiError('DUPLICATE', `Tipe "${name}" sudah ada (id=${dup.id})`);
  }
  try {
    const created = await ProductType.create({ name, is_active: true });
    return { id: created.id, name: created.name ?? null, is_active: created.is_active ?? true };
  } catch (err) {
    throw mapOrmError(err);
  }
}
