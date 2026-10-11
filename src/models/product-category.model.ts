import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';

export interface ProductCategoryAttributes {
  id: number;
  name: string | null;
  /** FK ke `product_type` (dihidupkan modelnya pada MP-2). */
  id_type: number | null;
  is_active: boolean | null;
}

export type ProductCategoryCreationAttributes = Optional<ProductCategoryAttributes, 'id'>;

/** Bentuk ringkas hasil include tipe (dipakai service, bukan kolom tabel). */
export interface ProductTypeRef {
  id: number;
  name: string | null;
}

/** `product_category` (tanpa kolom waktu) -> `timestamps: false`. */
export class ProductCategory extends Model<ProductCategoryAttributes, ProductCategoryCreationAttributes> {
  declare id: number;
  declare name: string | null;
  declare id_type: number | null;
  declare is_active: boolean | null;

  /** Tipe ikut di-attach lewat `ProductCategory.belongsTo(ProductType, { as: 'type' })`. */
  declare type?: ProductTypeRef | null;
}

export function initProductCategory(sequelize: Sequelize): void {
  ProductCategory.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING },
      id_type: { type: DataTypes.INTEGER },
      is_active: { type: DataTypes.BOOLEAN },
    },
    {
      sequelize,
      tableName: 'product_category',
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  );
}