import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

export interface ProductTypeAttributes {
  id: number;
  name: string | null;
  is_active: boolean | null;
}

export type ProductTypeCreationAttributes = Optional<ProductTypeAttributes, 'id'>;

/**
 * `product_type` — induk kategori (`product_category.id_type`), tabel WITHOUT ROWS
 * waktu (lihat header `src/models/index.ts`) -> `timestamps: false`.
 *
 * Baris lama boleh punya `is_active` NULL; service behandilnya sebagai aktif
 * (parity dengan `COALESCE(is_active, true)` di SQL lama).
 */
export class ProductType extends Model<ProductTypeAttributes, ProductTypeCreationAttributes> {
  declare id: number;
  declare name: string | null;
  declare is_active: boolean | null;
}

export function initProductType(sequelize: Sequelize): void {
  ProductType.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING },
      is_active: { type: DataTypes.BOOLEAN },
    },
    {
      sequelize,
      tableName: 'product_type',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}
