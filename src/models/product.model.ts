import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

export interface ProductAttributes {
  id: number;
  name: string | null;
  category_id: number | null;
  /** Typo yang melekat di schema lama; response API tetap expose sebagai `description`. */
  desctiption: string | null;
  harga_beli: number | null;
  harga_jual: number | null;
  sku: string | null;
  unit: string | null;
  attributes: Record<string, unknown> | null;
  is_active: boolean | null;
  created_at: Date;
  updated_at: Date;
  barcode: string | null;
  min_stock: number | null;
  unit_conversions: Record<string, number> | null;
}

export type ProductCreationAttributes = Optional<
  ProductAttributes,
  'id' | 'created_at' | 'updated_at' | 'unit' | 'attributes' | 'is_active' | 'min_stock'
>;

/**
 * `product` — soft delete lewat `is_active=false` (histori batch/ledger tetap utuh,
 * sama seperti DELETE lama). Default scope menyembunyikan produk nonaktif; pakai
 * `.scope('withInactive')` untuk endpoint yang secara kontrak tetap membaca
 * produk nonaktif (mis. `GET /products/{id}` setelah soft delete).
 */
export class Product extends Model<ProductAttributes, ProductCreationAttributes> {
  declare id: number;
  declare name: string | null;
  declare category_id: number | null;
  declare desctiption: string | null;
  declare harga_beli: number | null;
  declare harga_jual: number | null;
  declare sku: string | null;
  declare unit: string | null;
  declare attributes: Record<string, unknown> | null;
  declare is_active: boolean | null;
  declare created_at: Date;
  declare updated_at: Date;
  declare barcode: string | null;
  declare min_stock: number | null;
  declare unit_conversions: Record<string, number> | null;

  /** Kategori ikut di-attach lewat `Product.belongsTo(ProductCategory, { as: 'category' })`. */
  declare category?: ProductCategoryRef | null;
}

/** Bentuk ringkas hasil include kategori (dipakai service, bukan kolom tabel). */
export interface ProductCategoryRef {
  id: number;
  name: string | null;
}

export function initProduct(sequelize: Sequelize): void {
  Product.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING },
      category_id: { type: DataTypes.INTEGER },
      desctiption: { type: DataTypes.STRING },
      harga_beli: { type: DataTypes.DECIMAL(14, 2) },
      harga_jual: { type: DataTypes.DECIMAL(14, 2) },
      sku: { type: DataTypes.STRING(64) },
      unit: { type: DataTypes.STRING(16), defaultValue: 'pcs' },
      attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      barcode: { type: DataTypes.STRING(64) },
      min_stock: { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: 0 },
      unit_conversions: { type: DataTypes.JSONB },
    },
    {
      sequelize,
      tableName: 'product',
      freezeTableName: true,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      defaultScope: {
        where: { is_active: true },
      },
      scopes: {
        // Menggantikan default scope: tanpa filter is_active.
        withInactive: {},
        // Hanya produk nonaktif (dipakai audit/filter `active=false`).
        onlyInactive: { where: { is_active: false } },
      },
    },
  );
}