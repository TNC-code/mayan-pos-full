import { Op, type Includeable } from 'sequelize';
import { ApiError, notFound } from '../utils/errors.js';
import { mapOrmError } from '../utils/orm-errors.js';
import { Product, ProductCategory } from '../models/index.js';

/**
 * CRUD produk di atas Sequelize.
 *
 * Bentuk response (`ProductRow`) dan semantik filter DISAMAKAN PERSIS dengan
 * implementasi raw SQL lama (`git show HEAD:src/services/product.service.ts`):
 *  - kolom `desctiption` (typo schema) diekspos sebagai `description`;
 *  - `category_name` diambil dari LEFT JOIN `product_category`;
 *  - list: filter q (name/sku/barcode ILIKE), category_id, `active`;
 *    tanpa `active` -> produk nonaktif TETAP tampil (parity), `limit/offset`,
 *    urutan `name ASC`;
 *  - create: default `unit='pcs'`, `attributes={}`, `is_active=true`, `min_stock=0`;
 *  - update: patch semantics (hanya kolom yang dikirim) + `updated_at = now()`;
 *  - delete = soft (`is_active=false`), bukan hard delete.
 *
 * Catatan scope: default scope model menyembunyikan produk nonaktif; endpoint ini
 * secara kontrak tetap membacanya -> selalu lewat `.scope('withInactive')`.
 */

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

export interface ProductListQuery {
  q?: string;
  category_id?: number;
  active?: boolean;
  limit: number;
  offset: number;
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

const WITH_CATEGORY: Includeable = {
  model: ProductCategory,
  as: 'category',
  attributes: ['id', 'name'],
  required: false,
};

type ProductWithCategory = Product & { category?: { id: number; name: string | null } | null };

function toProductRow(row: ProductWithCategory): ProductRow {
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name ?? '',
    unit: row.unit,
    category_id: row.category_id,
    category_name: row.category?.name ?? null,
    description: row.desctiption,
    harga_beli: row.harga_beli,
    harga_jual: row.harga_jual,
    attributes: row.attributes ?? {},
    is_active: row.is_active ?? true,
    min_stock: row.min_stock ?? 0,
    unit_conversions: row.unit_conversions,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function listProducts(q: ProductListQuery): Promise<ProductRow[]> {
  const where_: Record<string, unknown>[] = [];

  if (q.q) {
    // ILIKE atas name/sku/barcode (sama seperti SQL lama). Dipakai bentuk objek
    // supaya Sequelize yang menuliskan qualify kolom ke alias tabel yang benar.
    const like = `%${q.q}%`;
    where_.push({
      [Op.or]: [{ name: { [Op.iLike]: like } }, { sku: { [Op.iLike]: like } }, { barcode: { [Op.iLike]: like } }],
    });
  }
  if (q.category_id !== undefined) where_.push({ category_id: q.category_id });
  if (q.active !== undefined) where_.push({ is_active: q.active });

  const rows = await Product.scope('withInactive').findAll({
    where: { [Op.and]: where_ },
    include: [WITH_CATEGORY],
    order: [['name', 'ASC']],
    limit: q.limit,
    offset: q.offset,
  });

  return (rows as unknown as ProductWithCategory[]).map(toProductRow);
}

export async function getProduct(id: number): Promise<ProductRow> {
  const row = await Product.scope('withInactive').findByPk(id, { include: [WITH_CATEGORY] });
  if (!row) throw notFound(`Produk id=${id} tidak ditemukan`);
  return toProductRow(row as unknown as ProductWithCategory);
}

/** Baris produk TANPA filter `is_active` (patch/soft delete harus bisa kena produk nonaktif). */
async function findProductRow(id: number): Promise<Product> {
  const row = await Product.scope('withInactive').findByPk(id);
  if (!row) throw notFound(`Produk id=${id} tidak ditemukan`);
  return row;
}

export async function createProduct(input: ProductInput): Promise<ProductRow> {
  let created;
  try {
    created = await Product.create({
      sku: input.sku ?? null,
      barcode: input.barcode ?? null,
      name: input.name,
      unit: input.unit ?? 'pcs',
      category_id: input.category_id ?? null,
      desctiption: input.description ?? null,
      harga_beli: input.harga_beli ?? null,
      harga_jual: input.harga_jual ?? null,
      attributes: input.attributes ?? {},
      is_active: input.is_active ?? true,
      min_stock: input.min_stock ?? 0,
      unit_conversions: input.unit_conversions ?? null,
    });
  } catch (err) {
    // SKU/barcode kembar (uq_product_sku/uq_product_barcode) -> 409 DUPLICATE.
    throw mapOrmError(err);
  }
  return getProduct(created.id);
}

/** Patch semantics: hanya kolom yang dikirim yang diubah. */
export async function updateProduct(id: number, input: Partial<ProductInput>): Promise<ProductRow> {
  const patch: Record<string, unknown> = {};

  if (input.name !== undefined) patch.name = input.name;
  if (input.sku !== undefined) patch.sku = input.sku;
  if (input.barcode !== undefined) patch.barcode = input.barcode;
  if (input.unit !== undefined) patch.unit = input.unit;
  if (input.category_id !== undefined) patch.category_id = input.category_id;
  if (input.description !== undefined) patch.desctiption = input.description;
  if (input.harga_beli !== undefined) patch.harga_beli = input.harga_beli;
  if (input.harga_jual !== undefined) patch.harga_jual = input.harga_jual;
  if (input.attributes !== undefined) patch.attributes = input.attributes;
  if (input.min_stock !== undefined) patch.min_stock = input.min_stock;
  if (input.unit_conversions !== undefined) patch.unit_conversions = input.unit_conversions;
  if (input.is_active !== undefined) patch.is_active = input.is_active;

  if (Object.keys(patch).length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Tidak ada kolom yang akan diubah');
  }

  const row = await findProductRow(id);
  try {
    await row.update(patch);
  } catch (err) {
    // SKU/barcode kembar saat patch -> 409 DUPLICATE (parity dengan jalur raw SQL).
    throw mapOrmError(err);
  }
  return getProduct(id);
}

/**
 * Soft delete: produk nonaktif, histori stok & ledger tetap utuh.
 * Hard delete ditolak bila produk sudah pernah dipakai di batch/sale (FK).
 */
export async function deactivateProduct(id: number): Promise<ProductRow> {
  const row = await findProductRow(id);
  await row.update({ is_active: false });
  return getProduct(id);
}